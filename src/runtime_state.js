const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('config');
const { logger } = require('./common');

class RuntimeState {
    constructor() {
        const runtimeCfg = config.has('runtime') ? config.get('runtime') : {};
        this.dbPath = path.resolve(runtimeCfg.dbPath || './data/runtime.db');
        this.db = null;
    }

    async init() {
        await this._openDb();
        await this._migrate();
        return this;
    }

    _openDb() {
        return new Promise((resolve, reject) => {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    logger.log('error', `[RuntimeState] Failed to open DB at ${this.dbPath}: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    _migrate() {
        const sql = `
            CREATE TABLE IF NOT EXISTS device_state (
                device_id TEXT PRIMARY KEY,
                address TEXT,
                poll_class TEXT,
                schedule TEXT,
                circuit_state TEXT NOT NULL DEFAULT 'closed',
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at INTEGER,
                last_success_at INTEGER,
                last_duration_ms INTEGER,
                next_eligible_poll_at INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS object_state (
                device_id TEXT NOT NULL,
                object_key TEXT NOT NULL,
                value_json TEXT,
                object_name TEXT,
                acquired_at INTEGER,
                published_at INTEGER,
                freshness_ms INTEGER,
                source_status TEXT,
                poll_duration_ms INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (device_id, object_key)
            );
            CREATE TABLE IF NOT EXISTS poll_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                object_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                failure_count INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                error_class TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_poll_history_device_created_at
                ON poll_history(device_id, created_at DESC);
        `;

        return new Promise((resolve, reject) => {
            this.db.exec(sql, (err) => {
                if (err) {
                    logger.log('error', `[RuntimeState] Migration failed: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ lastID: this.lastID, changes: this.changes });
                }
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async upsertDeviceState(state) {
        const now = Date.now();
        await this.run(
            `
            INSERT INTO device_state (
                device_id, address, poll_class, schedule, circuit_state, consecutive_failures,
                last_error, last_attempt_at, last_success_at, last_duration_ms, next_eligible_poll_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                address = excluded.address,
                poll_class = excluded.poll_class,
                schedule = excluded.schedule,
                circuit_state = excluded.circuit_state,
                consecutive_failures = excluded.consecutive_failures,
                last_error = excluded.last_error,
                last_attempt_at = excluded.last_attempt_at,
                last_success_at = excluded.last_success_at,
                last_duration_ms = excluded.last_duration_ms,
                next_eligible_poll_at = excluded.next_eligible_poll_at,
                updated_at = excluded.updated_at
            `,
            [
                state.deviceId,
                state.address || null,
                state.pollClass || null,
                state.schedule || null,
                state.circuitState || 'closed',
                state.consecutiveFailures || 0,
                state.lastError || null,
                state.lastAttemptAt || null,
                state.lastSuccessAt || null,
                state.lastDurationMs || null,
                state.nextEligiblePollAt || null,
                now
            ]
        );
    }

    async saveObjectTelemetry(deviceId, objectKey, telemetry) {
        const now = Date.now();
        await this.run(
            `
            INSERT INTO object_state (
                device_id, object_key, value_json, object_name, acquired_at, published_at,
                freshness_ms, source_status, poll_duration_ms, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, object_key) DO UPDATE SET
                value_json = excluded.value_json,
                object_name = excluded.object_name,
                acquired_at = excluded.acquired_at,
                published_at = excluded.published_at,
                freshness_ms = excluded.freshness_ms,
                source_status = excluded.source_status,
                poll_duration_ms = excluded.poll_duration_ms,
                updated_at = excluded.updated_at
            `,
            [
                deviceId,
                objectKey,
                JSON.stringify(telemetry.value),
                telemetry.name || null,
                telemetry.acquiredAt || null,
                telemetry.publishedAt || null,
                telemetry.freshnessMs || null,
                telemetry.sourceStatus || null,
                telemetry.pollDurationMs || null,
                now
            ]
        );
    }

    async recordPollHistory(entry) {
        await this.run(
            `
            INSERT INTO poll_history (
                device_id, object_count, success_count, failure_count, duration_ms, status, error_class, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                entry.deviceId,
                entry.objectCount || 0,
                entry.successCount || 0,
                entry.failureCount || 0,
                entry.durationMs || 0,
                entry.status || 'unknown',
                entry.errorClass || null,
                entry.createdAt || Date.now()
            ]
        );
    }

    getDeviceState(deviceId) {
        return this.get('SELECT * FROM device_state WHERE device_id = ?', [deviceId]);
    }

    listDeviceStates() {
        return this.all('SELECT * FROM device_state ORDER BY device_id ASC');
    }

    async getLatestObjectState(deviceId, objectKey) {
        const row = await this.get(
            'SELECT * FROM object_state WHERE device_id = ? AND object_key = ?',
            [deviceId, objectKey]
        );
        if (!row) {
            return null;
        }
        return {
            ...row,
            value: row.value_json ? JSON.parse(row.value_json) : null
        };
    }

    async listObjectStates(deviceId) {
        const rows = await this.all(
            'SELECT * FROM object_state WHERE device_id = ? ORDER BY object_key ASC',
            [deviceId]
        );
        return rows.map((row) => ({
            ...row,
            value: row.value_json ? JSON.parse(row.value_json) : null
        }));
    }

    async getMetricsSummary() {
        const deviceRows = await this.all('SELECT * FROM device_state');
        const openCircuits = deviceRows.filter((row) => row.circuit_state === 'open').length;
        const degradedDevices = deviceRows.filter((row) => row.consecutive_failures > 0).length;
        const healthyDevices = deviceRows.filter((row) => row.consecutive_failures === 0).length;
        const staleRows = await this.get(
            'SELECT COUNT(*) as count FROM object_state WHERE acquired_at IS NOT NULL AND freshness_ms IS NOT NULL AND (? - acquired_at) > freshness_ms',
            [Date.now()]
        );
        return {
            configuredDevices: deviceRows.length,
            healthyDevices,
            degradedDevices,
            openCircuits,
            staleObjects: staleRows ? staleRows.count : 0
        };
    }
}

module.exports = { RuntimeState };
