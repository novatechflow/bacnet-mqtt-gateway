process.env.NODE_CONFIG_STRICT_MODE = '0';

const EventEmitter = require('events');

const mockReadPropertyMultiple = jest.fn();
const mockOn = jest.fn();
const mockWriteProperty = jest.fn();
const mockWhoIs = jest.fn();

jest.mock('bacstack', () => {
    const ctor = jest.fn(() => ({
        readPropertyMultiple: mockReadPropertyMultiple,
        on: mockOn,
        writeProperty: mockWriteProperty,
        whoIs: mockWhoIs
    }));
    ctor.enum = {
        ObjectTypes: { OBJECT_DEVICE: 8 },
        PropertyIds: { PROP_OBJECT_LIST: 77, PROP_PRESENT_VALUE: 85, PROP_OBJECT_NAME: 77 },
        ApplicationTags: {
            BACNET_APPLICATION_TAG_BOOLEAN: 1,
            BACNET_APPLICATION_TAG_SIGNED_INT: 2,
            BACNET_APPLICATION_TAG_REAL: 4,
            BACNET_APPLICATION_TAG_CHARACTER_STRING: 7
        }
    };
    return ctor;
});

jest.mock('../src/bacnet_config', () => {
    const { EventEmitter } = require('events');
    return {
        BacnetConfig: class extends EventEmitter {
            load() {
                // no-op for tests
            }
        }
    };
});

jest.mock('../src/common', () => ({
    logger: { log: jest.fn() },
    DeviceObjectId: class {},
    DeviceObject: class {}
}));

jest.mock('../src/mqtt_client', () => ({
    MqttClient: class extends require('events') {}
}));

describe('BacnetClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('scanDevice rejects when readPropertyMultiple returns an error', async () => {
        const error = new Error('mock failure');
        mockReadPropertyMultiple.mockImplementation((_addr, _req, _opts, cb) => cb(error));

        const { BacnetClient } = require('../src/bacnet_client');
        const client = new BacnetClient();

        await expect(
            client.scanDevice({ address: '10.0.0.1', deviceId: 123 })
        ).rejects.toThrow('mock failure');
    });
});
