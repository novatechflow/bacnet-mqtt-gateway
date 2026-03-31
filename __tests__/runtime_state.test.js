const fs = require('fs');
const os = require('os');
const path = require('path');

describe('RuntimeState', () => {
    let tempDir;
    let dbPath;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-'));
        dbPath = path.join(tempDir, 'runtime.db');
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            runtime: { dbPath }
        });
        jest.resetModules();
    });

    afterEach(() => {
        Object.keys(process.env).forEach((k) => {
            if (!(k in originalEnv)) delete process.env[k];
        });
        Object.entries(originalEnv).forEach(([k, v]) => (process.env[k] = v));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('persists device and object telemetry and computes summary', async () => {
        const { RuntimeState } = require('../src/runtime_state');
        const state = new RuntimeState();
        await state.init();

        await state.upsertDeviceState({
            deviceId: '114',
            address: '192.168.1.10',
            pollClass: 'fast',
            schedule: null,
            circuitState: 'closed',
            consecutiveFailures: 0,
            lastError: null,
            lastAttemptAt: Date.now(),
            lastSuccessAt: Date.now(),
            lastDurationMs: 88,
            nextEligiblePollAt: Date.now()
        });
        await state.saveObjectTelemetry('114', '2_202', {
            value: 42,
            name: 'Room Temp',
            acquiredAt: Date.now() - 10000,
            publishedAt: Date.now() - 9000,
            freshnessMs: 1000,
            sourceStatus: 'fresh',
            pollDurationMs: 88
        });
        await state.recordPollHistory({
            deviceId: '114',
            objectCount: 1,
            successCount: 1,
            failureCount: 0,
            durationMs: 88,
            status: 'success',
            createdAt: Date.now()
        });

        const device = await state.getDeviceState('114');
        const object = await state.getLatestObjectState('114', '2_202');
        const summary = await state.getMetricsSummary();

        expect(device.poll_class).toBe('fast');
        expect(object.value).toBe(42);
        expect(summary.configuredDevices).toBe(1);
        expect(summary.staleObjects).toBe(1);
    });

    test('returns null for unknown object state and lists parsed objects', async () => {
        const { RuntimeState } = require('../src/runtime_state');
        const state = new RuntimeState();
        await state.init();

        await expect(state.getLatestObjectState('114', '2_999')).resolves.toBeNull();

        await state.saveObjectTelemetry('114', '2_201', {
            value: true,
            name: 'Occupied',
            acquiredAt: Date.now(),
            publishedAt: Date.now(),
            freshnessMs: 5000,
            sourceStatus: 'fresh',
            pollDurationMs: 10
        });
        await state.saveObjectTelemetry('114', '2_202', {
            value: 21.5,
            name: 'Temp',
            acquiredAt: Date.now(),
            publishedAt: Date.now(),
            freshnessMs: 5000,
            sourceStatus: 'fresh',
            pollDurationMs: 11
        });

        const rows = await state.listObjectStates('114');

        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(expect.objectContaining({ object_key: '2_201', value: true }));
        expect(rows[1]).toEqual(expect.objectContaining({ object_key: '2_202', value: 21.5 }));
    });

    test('summarizes healthy, degraded, and open-circuit devices', async () => {
        const { RuntimeState } = require('../src/runtime_state');
        const state = new RuntimeState();
        await state.init();

        await state.upsertDeviceState({
            deviceId: '100',
            address: '10.0.0.1',
            pollClass: 'fast',
            circuitState: 'closed',
            consecutiveFailures: 0
        });
        await state.upsertDeviceState({
            deviceId: '101',
            address: '10.0.0.2',
            pollClass: 'normal',
            circuitState: 'open',
            consecutiveFailures: 3
        });

        const states = await state.listDeviceStates();
        const summary = await state.getMetricsSummary();

        expect(states).toHaveLength(2);
        expect(summary).toEqual(expect.objectContaining({
            configuredDevices: 2,
            healthyDevices: 1,
            degradedDevices: 1,
            openCircuits: 1
        }));
    });
});
