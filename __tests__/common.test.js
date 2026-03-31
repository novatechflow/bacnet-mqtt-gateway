describe('common module', () => {
    beforeEach(() => {
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            logger: { level: 'info' }
        });
        jest.resetModules();
    });

    afterEach(() => {
        delete process.env.NODE_CONFIG;
        delete process.env.NODE_ENV;
        delete process.env.NODE_CONFIG_STRICT_MODE;
        jest.resetModules();
    });

    test('DeviceObjectId and DeviceObject preserve constructor values', () => {
        const { DeviceObjectId, DeviceObject } = require('../src/common');
        const objectId = new DeviceObjectId(2, 202);
        const object = new DeviceObject(objectId, 'Room Temp', 'Temperature', 2, 'degC', 21.5);

        expect(object.objectId).toBe(objectId);
        expect(object.name).toBe('Room Temp');
        expect(object.presentValue).toBe(21.5);
    });
});
