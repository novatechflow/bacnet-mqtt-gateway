jest.mock('mqtt', () => {
    const { EventEmitter } = require('events');
    const publishMock = jest.fn((topic, message, options, cb) => {
        if (typeof options === 'function') {
            options();
        } else if (typeof cb === 'function') {
            cb();
        }
    });
    const subscribeMock = jest.fn((pattern, cb) => cb && cb());
    let clientInstance;
    return {
        __getMocks: () => ({
            publishMock,
            subscribeMock,
            get clientInstance() {
                return clientInstance;
            }
        }),
        connect: jest.fn(() => {
            clientInstance = new EventEmitter();
            clientInstance.publish = publishMock;
            clientInstance.subscribe = subscribeMock;
            return clientInstance;
        })
    };
});

jest.mock('../src/common', () => ({
    logger: { log: jest.fn() }
}));

describe('MqttClient', () => {
    const originalEnv = { ...process.env };
    let mqttMocks;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NODE_CONFIG = JSON.stringify({
            mqtt: { gatewayId: 'test-gw', host: 'localhost', port: 1883, username: 'u', password: 'p' }
        });
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        jest.resetModules();
        mqttMocks = require('mqtt').__getMocks();
    });

    afterEach(() => {
        Object.keys(process.env).forEach((k) => {
            if (!(k in originalEnv)) delete process.env[k];
        });
        Object.entries(originalEnv).forEach(([k, v]) => (process.env[k] = v));
        jest.resetModules();
    });

    test('publishMessage publishes telemetry to state, attributes, and canonical topics', async () => {
        const { MqttClient } = require('../src/mqtt_client');
        const client = new MqttClient();
        mqttMocks.clientInstance.emit('connect');

        client.publishMessage({
            '2_202': {
                value: 42,
                name: 'Room Temp',
                deviceId: '114',
                address: '192.168.1.10',
                acquiredAt: 1000,
                publishedAt: 1100,
                freshnessMs: 5000,
                sourceStatus: 'fresh',
                pollDurationMs: 80,
                pollClass: 'fast'
            }
        });

        expect(mqttMocks.publishMock).toHaveBeenCalledWith(
            'homeassistant/sensor/test-gw/2_202/state',
            JSON.stringify(42),
            { retain: true },
            expect.any(Function)
        );
        expect(mqttMocks.publishMock).toHaveBeenCalledWith(
            'homeassistant/sensor/test-gw/2_202/attributes',
            expect.stringContaining('"sourceStatus":"fresh"'),
            { retain: true },
            expect.any(Function)
        );
        expect(mqttMocks.publishMock).toHaveBeenCalledWith(
            'bacnet-gateway/test-gw/telemetry/114/2_202',
            expect.stringContaining('"pollClass":"fast"'),
            { retain: true },
            expect.any(Function)
        );
        expect(client.getStatus().publishSuccessCount).toBe(3);
    });

    test('publishMessage skips empty object', async () => {
        const { MqttClient } = require('../src/mqtt_client');
        const client = new MqttClient();
        mqttMocks.clientInstance.emit('connect');

        client.publishMessage({});

        expect(mqttMocks.publishMock).not.toHaveBeenCalled();
    });

    test('onMessage ignores messages for other gateways', async () => {
        const { MqttClient } = require('../src/mqtt_client');
        const client = new MqttClient();
        mqttMocks.clientInstance.emit('connect');

        const handler = jest.fn();
        client.on('bacnetWriteCommand', handler);

        const topic = 'bacnetwrite/other-gw/114/2_202/85/set';
        mqttMocks.clientInstance.emit('message', topic, Buffer.from('{"value":1}'));

        expect(handler).not.toHaveBeenCalled();
    });

    test('onMessage emits bacnetWriteCommand for matching gateway', async () => {
        const { MqttClient } = require('../src/mqtt_client');
        const client = new MqttClient();
        mqttMocks.clientInstance.emit('connect');

        const handler = jest.fn();
        client.on('bacnetWriteCommand', handler);

        const topic = 'bacnetwrite/test-gw/114/1_0/85/set';
        mqttMocks.clientInstance.emit('message', topic, Buffer.from('{"value":1,"priority":8}'));

        expect(handler).toHaveBeenCalledWith({
            deviceId: '114',
            objectKey: '1_0',
            objectType: 1,
            objectInstance: 0,
            propertyId: 85,
            value: 1,
            priority: 8,
            bacnetApplicationTag: undefined
        });
    });
});
