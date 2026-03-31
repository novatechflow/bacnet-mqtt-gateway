process.env.NODE_CONFIG_STRICT_MODE = '0';

const mockReadPropertyMultiple = jest.fn();
const mockWriteProperty = jest.fn();
const mockWhoIs = jest.fn();
const mockScheduleJob = jest.fn();

jest.mock('bacstack', () => {
    const ctor = jest.fn(() => {
        const { EventEmitter } = require('events');
        const emitter = new EventEmitter();
        emitter.readPropertyMultiple = mockReadPropertyMultiple;
        emitter.writeProperty = mockWriteProperty;
        emitter.whoIs = mockWhoIs;
        return emitter;
    });
    ctor.enum = {
        ObjectTypes: { OBJECT_DEVICE: 8 },
        PropertyIds: {
            PROP_OBJECT_LIST: 76,
            PROP_PRESENT_VALUE: 85,
            PROP_OBJECT_NAME: 77,
            PROP_OBJECT_IDENTIFIER: 75,
            PROP_OBJECT_TYPE: 79,
            PROP_DESCRIPTION: 28,
            PROP_UNITS: 117
        },
        ApplicationTags: {
            BACNET_APPLICATION_TAG_BOOLEAN: 1,
            BACNET_APPLICATION_TAG_SIGNED_INT: 2,
            BACNET_APPLICATION_TAG_REAL: 4,
            BACNET_APPLICATION_TAG_CHARACTER_STRING: 7
        }
    };
    return ctor;
});

jest.mock('../src/common', () => ({
    logger: { log: jest.fn() },
    DeviceObjectId: class DeviceObjectId {
        constructor(type, instance) {
            this.type = type;
            this.instance = instance;
        }
    },
    DeviceObject: class DeviceObject {
        constructor(objectId, name, description, type, units, presentValue) {
            this.objectId = objectId;
            this.name = name;
            this.description = description;
            this.type = type;
            this.units = units;
            this.presentValue = presentValue;
        }
    }
}));

jest.mock('node-schedule', () => ({
    scheduleJob: mockScheduleJob
}));

class MockBacnetConfig extends (require('events').EventEmitter) {
    load() {}
    save() {}
}

describe('BacnetClient', () => {
    let runtimeState;
    let bacnetConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            bacnet: { maxSegments: 112, maxAdpu: 5 },
            polling: {
                globalConcurrency: 1,
                objectConcurrency: 2,
                schedulerTickMs: 1000,
                defaultFreshnessMs: 30000,
                failureThreshold: 2,
                baseBackoffMs: 1000,
                maxBackoffMs: 5000,
                classIntervals: { fast: 1000, normal: 5000, slow: 10000 }
            }
        });
        runtimeState = {
            init: jest.fn().mockResolvedValue(undefined),
            upsertDeviceState: jest.fn().mockResolvedValue(undefined),
            saveObjectTelemetry: jest.fn().mockResolvedValue(undefined),
            recordPollHistory: jest.fn().mockResolvedValue(undefined),
            listDeviceStates: jest.fn().mockResolvedValue([])
        };
        bacnetConfig = new MockBacnetConfig();
        jest.resetModules();
    });

    afterEach(() => {
        jest.useRealTimers();
        delete process.env.NODE_CONFIG;
        delete process.env.NODE_ENV;
        jest.resetModules();
    });

    function buildValueResponse(type, instance, value, name = 'Temp') {
        return {
            values: [{
                objectId: { type, instance },
                values: [
                    { id: 85, value: [{ value }] },
                    { id: 77, value: [{ value: name }] }
                ]
            }]
        };
    }

    function cleanup(client) {
        clearInterval(client.schedulerHandle);
    }

    test('scanDevice rejects when readPropertyMultiple returns an error', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, _req, _opts, cb) => cb(new Error('mock failure')));

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await expect(
            client.scanDevice({ address: '10.0.0.1', deviceId: 123 })
        ).rejects.toThrow('mock failure');

        cleanup(client);
    });

    test('scanForDevices delegates to BACnet whoIs', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        client.scanForDevices();

        expect(mockWhoIs).toHaveBeenCalled();
        cleanup(client);
    });

    test('scanDevice returns mapped device objects on success', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, requestArray, _opts, cb) => {
            const request = requestArray[0];
            if (request.objectId.type === 8) {
                cb(null, {
                    values: [{
                        values: [{
                            value: [
                                { value: { type: 2, instance: 202 } }
                            ]
                        }]
                    }]
                });
                return;
            }
            cb(null, {
                values: [{
                    objectId: request.objectId,
                    values: [
                        { id: 75, value: [{ value: request.objectId }] },
                        { id: 77, value: [{ value: 'Zone Temp' }] },
                        { id: 79, value: [{ value: request.objectId.type }] },
                        { id: 28, value: [{ value: 'Room temperature' }] },
                        { id: 117, value: [{ value: 'degC' }] },
                        { id: 85, value: [{ value: 22.3 }] }
                    ]
                }]
            });
        });

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        const objects = await client.scanDevice({ address: '10.0.0.1', deviceId: 123 });

        expect(objects).toHaveLength(1);
        expect(objects[0].name).toBe('Zone Temp');
        cleanup(client);
    });

    test('pollDevice emits telemetry with freshness metadata and persists state', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, requestArray, _opts, cb) => {
            const objectId = requestArray[0].objectId;
            cb(null, buildValueResponse(objectId.type, objectId.instance, 42.5, 'Zone Temp'));
        });

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        await client.startPolling(
            { deviceId: 114, address: '192.168.1.10' },
            [{ objectId: { type: 2, instance: 202 } }],
            { class: 'fast', intervalMs: 1000, freshnessMs: 2000 }
        );

        const handler = jest.fn();
        client.on('values', handler);

        await client._pollDevice('114');

        expect(handler).toHaveBeenCalledTimes(1);
        const [, values] = handler.mock.calls[0];
        expect(values['2_202']).toMatchObject({
            value: 42.5,
            name: 'Zone Temp',
            deviceId: '114',
            sourceStatus: 'fresh',
            freshnessMs: 2000,
            pollClass: 'fast'
        });
        expect(runtimeState.saveObjectTelemetry).toHaveBeenCalledWith(
            '114',
            '2_202',
            expect.objectContaining({ value: 42.5, sourceStatus: 'fresh' })
        );
        expect(runtimeState.recordPollHistory).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'success', successCount: 1, failureCount: 0 })
        );

        cleanup(client);
    });

    test('pollDevice applies backoff and opens circuit after repeated failures', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, _req, _opts, cb) => {
            cb(new Error('timeout'));
        });

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        await client.startPolling(
            { deviceId: 55, address: '192.168.1.55' },
            [{ objectId: { type: 2, instance: 1 } }],
            { class: 'normal', intervalMs: 1000 }
        );

        await client._pollDevice('55');
        await client._pollDevice('55');

        const runtime = client.deviceRuntime.get('55');
        expect(runtime.consecutiveFailures).toBe(2);
        expect(runtime.circuitState).toBe('open');
        expect(runtime.nextEligiblePollAt).toBeGreaterThan(Date.now());
        expect(runtimeState.recordPollHistory).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'failed' })
        );

        cleanup(client);
    });

    test('writeProperty infers BACnet type and resolves on success', async () => {
        mockWriteProperty.mockImplementation((_address, _objectId, _propertyId, values, _options, cb) => {
            cb(null, { ok: true, values });
        });

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        const response = await client.writeProperty('192.168.1.10', { type: 1, instance: 0 }, 85, true);

        expect(mockWriteProperty).toHaveBeenCalledWith(
            '192.168.1.10',
            { type: 1, instance: 0 },
            85,
            [{ type: 1, value: 1 }],
            expect.any(Object),
            expect.any(Function)
        );
        expect(response.ok).toBe(true);
        cleanup(client);
    });

    test('scheduler enqueues due devices and drains queue within concurrency limit', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, requestArray, _opts, cb) => {
            const objectId = requestArray[0].objectId;
            cb(null, buildValueResponse(objectId.type, objectId.instance, 1, 'State'));
        });

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        await client.startPolling(
            { deviceId: 77, address: '192.168.1.77' },
            [{ objectId: { type: 3, instance: 9 } }],
            { class: 'fast', intervalMs: 1000 }
        );

        const spy = jest.spyOn(client, '_pollDevice');
        await client._schedulerLoop();

        expect(spy).toHaveBeenCalledWith('77');
        await spy.mock.results[0].value;
        expect(client.getStatus().totalPolls).toBe(1);

        cleanup(client);
    });

    test('emits deviceFound on iAm and loads request options', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        const handler = jest.fn();
        client.on('deviceFound', handler);

        client.client.emit('iAm', { deviceId: 99, address: '10.0.0.99' });

        expect(handler).toHaveBeenCalledWith({ deviceId: 99, address: '10.0.0.99' });
        expect(client.requestOptions).toEqual({ maxSegments: 112, maxAdpu: 5 });
        expect(client._buildRequestOptions(8)).toEqual({ maxSegments: 112, maxAdpu: 5, priority: 8 });
        cleanup(client);
    });

    test('registerDeviceConfig ignores invalid configs and saveConfig persists valid ones', async () => {
        const { logger } = require('../src/common');
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        jest.spyOn(client, '_registerDeviceConfig');
        await client.ready;

        await client._registerDeviceConfig({});
        expect(logger.log).toHaveBeenCalledWith('warn', '[BacnetClient] Loaded a device config without a valid deviceId.');

        const saveSpy = jest.spyOn(bacnetConfig, 'save');
        await client.saveConfig({
            device: { deviceId: 88, address: '10.0.0.88' },
            polling: { class: 'slow', schedule: '*/5 * * * * *' },
            objects: [{ objectId: { type: 2, instance: 8 } }]
        });

        expect(saveSpy).toHaveBeenCalled();
        expect(client.deviceConfigs.get('88').polling.class).toBe('slow');
        cleanup(client);
    });

    test('configureSchedule cancels existing cron job and cron schedule sets due flag', async () => {
        const cancel = jest.fn();
        const scheduleJobMock = require('node-schedule').scheduleJob;
        scheduleJobMock.mockImplementationOnce((_expr, cb) => {
            cb();
            return { cancel };
        });
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await client.startPolling(
            { deviceId: 90, address: '10.0.0.90' },
            [{ objectId: { type: 2, instance: 1 } }],
            { schedule: '*/5 * * * * *', class: 'normal' }
        );
        const runtime = client.deviceRuntime.get('90');
        expect(runtime.cronDue).toBe(true);

        await client.startPolling(
            { deviceId: 90, address: '10.0.0.90' },
            [{ objectId: { type: 2, instance: 1 } }],
            { intervalMs: 5000, class: 'normal' }
        );

        expect(cancel).toHaveBeenCalled();
        cleanup(client);
    });

    test('schedulerLoop skips empty, queued, not-yet-eligible, and not-due devices', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        const now = Date.now();

        client.deviceRuntime.set('1', { objects: [], nextEligiblePollAt: now, schedule: null, nextDueAt: now, polling: { intervalMs: 1 } });
        client.deviceRuntime.set('2', { objects: [{ objectId: { type: 1, instance: 1 } }], nextEligiblePollAt: now, schedule: null, nextDueAt: now, polling: { intervalMs: 1 } });
        client.queuedDevices.add('2');
        client.deviceRuntime.set('3', { objects: [{ objectId: { type: 1, instance: 1 } }], nextEligiblePollAt: now + 5000, circuitState: 'closed', schedule: null, nextDueAt: now, polling: { intervalMs: 1 } });
        client.deviceRuntime.set('4', { objects: [{ objectId: { type: 1, instance: 1 } }], nextEligiblePollAt: now, circuitState: 'closed', schedule: null, nextDueAt: now + 5000, polling: { intervalMs: 1 } });

        const drainSpy = jest.spyOn(client, '_drainQueue').mockResolvedValue(undefined);
        await client._schedulerLoop();

        expect(client.queue).toHaveLength(0);
        expect(drainSpy).toHaveBeenCalled();
        cleanup(client);
    });

    test('runWithConcurrency captures worker errors and mapping helpers handle missing data', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        const results = await client._runWithConcurrency(
            [{ objectId: { type: 2, instance: 1 } }],
            1,
            async () => {
                throw new Error('worker failed');
            }
        );

        expect(results[0].result.error.message).toBe('worker failed');
        expect(client._findValueById([], 85)).toBeNull();
        expect(client._mapToDeviceObject(null)).toBeNull();
        cleanup(client);
    });

    test('scanDevice rejects when object reads fail catastrophically', async () => {
        const { logger } = require('../src/common');
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;
        jest.spyOn(client, '_readObjectList').mockImplementation((_addr, _id, cb) => cb(null, {
            values: [{ values: [{ value: [{ value: { type: 2, instance: 1 } }] }] }]
        }));
        jest.spyOn(client, '_readObjectFull').mockRejectedValue(new Error('catastrophic read'));

        await expect(client.scanDevice({ address: '10.0.0.5', deviceId: 5 })).rejects.toThrow('catastrophic read');
        expect(logger.log).toHaveBeenCalledWith('error', expect.stringContaining('catastrophic read'));
        cleanup(client);
    });

    test('writeProperty coerces ints, floats, strings, explicit booleans, and rejects unsupported values', async () => {
        mockWriteProperty.mockImplementation((_address, _objectId, _propertyId, values, _options, cb) => {
            cb(null, values);
        });
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, 7)).resolves.toEqual([{ type: 2, value: 7 }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, 7.5)).resolves.toEqual([{ type: 4, value: 7.5 }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, '42')).resolves.toEqual([{ type: 2, value: 42 }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, '42.5')).resolves.toEqual([{ type: 4, value: 42.5 }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, 'abc')).resolves.toEqual([{ type: 7, value: 'abc' }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, true, undefined, 1)).resolves.toEqual([{ type: 1, value: 1 }]);
        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, { bad: true })).rejects.toThrow('Unsupported value type');
        cleanup(client);
    });

    test('writeProperty rejects BACnet errors and runtime/list status helpers delegate correctly', async () => {
        const { logger } = require('../src/common');
        mockWriteProperty.mockImplementationOnce((_a, _b, _c, _d, _e, cb) => cb(new Error('write error')));
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await expect(client.writeProperty('a', { type: 1, instance: 1 }, 85, 1)).rejects.toThrow('write error');
        expect(logger.log).toHaveBeenCalledWith('error', expect.stringContaining('[BACnet Write] Error writing property: Error: write error'));
        await expect(client.listRuntimeStates()).resolves.toEqual([]);
        expect(client.getStatus()).toEqual(expect.objectContaining({
            configuredDevices: client.deviceConfigs.size,
            avgPollDurationMs: expect.any(Number)
        }));
        cleanup(client);
    });

    test('scheduler interval logs loop failures', async () => {
        const { logger } = require('../src/common');
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        jest.spyOn(client, '_schedulerLoop').mockRejectedValue(new Error('loop failed'));
        jest.advanceTimersByTime(client.schedulerTickMs);
        await Promise.resolve();

        expect(logger.log).toHaveBeenCalledWith('error', '[Polling] Scheduler loop failed: loop failed');
        cleanup(client);
    });

    test('configLoaded listener logs registration failures', async () => {
        const { logger } = require('../src/common');
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        jest.spyOn(client, '_registerDeviceConfig').mockRejectedValue(new Error('register failed'));
        bacnetConfig.emit('configLoaded', { device: { deviceId: 5, address: '10.0.0.5' } });
        await Promise.resolve();

        expect(logger.log).toHaveBeenCalledWith('error', '[Polling] Failed to register config: register failed');
        cleanup(client);
    });

    test('drainQueue logs poll and nested drain failures', async () => {
        const { logger } = require('../src/common');
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        client.queue.push('first', 'second');
        client.queuedDevices.add('first');
        client.queuedDevices.add('second');

        let pollCalls = 0;
        jest.spyOn(client, '_pollDevice').mockImplementation(async () => {
            pollCalls += 1;
            if (pollCalls === 1) {
                throw new Error('poll blew up');
            }
        });

        const drainSpy = jest.spyOn(client, '_drainQueue');
        const realDrain = drainSpy.getMockImplementation();
        drainSpy.mockImplementation(async function wrappedDrain() {
            if (pollCalls >= 1) {
                throw new Error('drain blew up');
            }
            return realDrain ? realDrain.apply(this, arguments) : undefined;
        });

        const immediateSpy = jest.spyOn(global, 'setImmediate').mockImplementation((fn) => {
            fn();
            return 0;
        });

        await client._drainQueue();
        await Promise.resolve();

        expect(logger.log).toHaveBeenCalledWith('error', '[Polling] Device poll failed for first: poll blew up');
        expect(logger.log).toHaveBeenCalledWith('error', '[Polling] Queue drain failed: drain blew up');

        immediateSpy.mockRestore();
        cleanup(client);
    });

    test('pollDevice returns early when runtime is missing', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await expect(client._pollDevice('missing')).resolves.toBeUndefined();

        cleanup(client);
    });
});
