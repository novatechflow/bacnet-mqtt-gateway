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
});
