process.env.NODE_CONFIG_STRICT_MODE = '0';

const mockReadPropertyMultiple = jest.fn();
const mockWriteProperty = jest.fn();
const mockWhoIs = jest.fn();

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

    test('scanDevice rejects when readPropertyMultiple returns an error', async () => {
        mockReadPropertyMultiple.mockImplementation((_addr, _req, _opts, cb) => cb(new Error('mock failure')));

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        await expect(
            client.scanDevice({ address: '10.0.0.1', deviceId: 123 })
        ).rejects.toThrow('mock failure');

        clearInterval(client.schedulerHandle);
    });

    test('scanForDevices delegates to BACnet whoIs', async () => {
        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient({ runtimeState, bacnetConfig });
        await client.ready;

        client.scanForDevices();

        expect(mockWhoIs).toHaveBeenCalled();
        clearInterval(client.schedulerHandle);
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
        clearInterval(client.schedulerHandle);
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

        clearInterval(client.schedulerHandle);
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

        clearInterval(client.schedulerHandle);
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
        clearInterval(client.schedulerHandle);
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

        clearInterval(client.schedulerHandle);
    });
});
