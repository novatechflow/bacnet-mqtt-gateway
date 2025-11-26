const fs = require('fs');
const os = require('os');
const path = require('path');

describe('BacnetConfig', () => {
    let tempDir;
    let loggerMock;
    const originalNodeEnv = process.env.NODE_ENV;

    const loadModule = () => {
        jest.resetModules();
        jest.doMock('../src/common', () => {
            loggerMock = { log: jest.fn() };
            return { logger: loggerMock };
        });
        return require('../src/bacnet_config');
    };

    beforeAll(() => {
        process.env.NODE_ENV = 'development';
    });

    afterAll(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    beforeEach(() => {
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bacnet-config-')) + path.sep;
        process.env.NODE_CONFIG = JSON.stringify({ bacnet: { configFolder: tempDir } });
    });

    afterEach(() => {
        delete process.env.NODE_CONFIG;
        delete process.env.NODE_CONFIG_STRICT_MODE;
        fs.rmSync(tempDir, { recursive: true, force: true });
        jest.resetModules();
    });

    test('delete removes file within configured devices folder', async () => {
        const configPath = path.join(tempDir, 'device.1.json');
        fs.writeFileSync(configPath, JSON.stringify({}));

        const { BacnetConfig } = loadModule();
        const config = new BacnetConfig();

        await config.delete(1);

        expect(fs.existsSync(configPath)).toBe(false);
    });

    test('load skips invalid JSON without crashing', async () => {
        const validPath = path.join(tempDir, 'device.2.json');
        const invalidPath = path.join(tempDir, 'device.invalid.json');
        fs.writeFileSync(validPath, JSON.stringify({ device: { deviceId: 2 } }));
        fs.writeFileSync(invalidPath, '{bad json');

        const { BacnetConfig } = loadModule();
        const config = new BacnetConfig();
        const loaded = [];

        config.on('configLoaded', (cfg) => loaded.push(cfg));
        config.load();

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(loaded).toHaveLength(1);
        expect(loaded[0].device.deviceId).toBe(2);
        expect(loggerMock.log).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('Error while parsing config file')
        );
    });
});
