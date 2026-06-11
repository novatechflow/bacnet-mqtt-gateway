const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('web admin app', () => {
    function createContext() {
        const createdApps = [];
        const context = {
            console: { error: jest.fn(), log: jest.fn() },
            localStorage: {
                store: new Map(),
                getItem(key) {
                    return this.store.has(key) ? this.store.get(key) : null;
                },
                setItem(key, value) {
                    this.store.set(key, value);
                },
                removeItem(key) {
                    this.store.delete(key);
                }
            },
            TextEncoder,
            TextDecoder,
            Uint8Array,
            atob: (value) => Buffer.from(value, 'base64').toString('binary'),
            btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
            crypto: {
                subtle: {
                    importKey: jest.fn().mockResolvedValue({}),
                    encrypt: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
                    decrypt: jest.fn().mockResolvedValue(new TextEncoder().encode('token').buffer)
                },
                getRandomValues: (buffer) => {
                    buffer.fill(1);
                    return buffer;
                }
            },
            window: {
                setInterval: jest.fn(),
                setTimeout: jest.fn((fn) => fn()),
                location: {
                    hostname: 'example.test',
                    search: ''
                }
            },
            setInterval: jest.fn(),
            setTimeout: jest.fn((fn) => fn()),
            clearTimeout: jest.fn(),
            clearInterval: jest.fn(),
            axios: {
                defaults: { headers: { common: {} } },
                interceptors: { response: { use: jest.fn() } },
                create: jest.fn(() => ({ post: jest.fn() })),
                post: jest.fn(),
                get: jest.fn(),
                put: jest.fn()
            },
            Vue: {
                createApp: jest.fn((options) => {
                    createdApps.push(options);
                    return { mount: jest.fn() };
                })
            },
            module: { exports: {} },
            exports: {}
        };
        context.global = context;
        context.globalThis = context;
        context.__createdApps = createdApps;
        return context;
    }

    function loadAdminScript() {
        const adminPath = path.join(__dirname, '..', 'web', 'admin.js');
        const script = fs.readFileSync(adminPath, 'utf8');
        const context = createContext();
        vm.runInNewContext(`${script}\nmodule.exports = { SessionVault, parseJwt, extractErrorMessage, appOptions: __createdApps[0] };`, context);
        return { context, exports: context.module.exports };
    }

    test('boots a Vue 3 app and exposes runtime-oriented views', () => {
        const { context, exports } = loadAdminScript();

        expect(context.Vue.createApp).toHaveBeenCalledTimes(1);
        expect(exports.appOptions.components).toEqual(expect.objectContaining({
            WhoisPanel: expect.any(Object),
            DeviceScan: expect.any(Object),
            ConfiguredDevices: expect.any(Object),
            RuntimeDevices: expect.any(Object),
            RuntimeObjects: expect.any(Object)
        }));
    });

    test('parseJwt returns payload and null for invalid tokens', () => {
        const { exports } = loadAdminScript();
        const payload = { sub: 1, username: 'admin', role: 'admin', exp: Math.floor(Date.now() / 1000) + 60 };
        const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

        expect(exports.parseJwt(token)).toEqual(payload);
        expect(exports.parseJwt('broken')).toBeNull();
    });

    test('extractErrorMessage prefers API message and falls back sanely', () => {
        const { exports } = loadAdminScript();

        expect(exports.extractErrorMessage({ response: { data: { message: 'api failed' } } }, 'fallback')).toBe('api failed');
        expect(exports.extractErrorMessage(new Error('network failed'), 'fallback')).toBe('network failed');
        expect(exports.extractErrorMessage({}, 'fallback')).toBe('fallback');
    });

    test('session vault stores encrypted access and refresh tokens', async () => {
        const { context, exports } = loadAdminScript();

        await exports.SessionVault.saveSession('access-token', 'refresh-token');

        expect(context.localStorage.getItem('bacnet_gateway_access_token')).toBeTruthy();
        expect(context.localStorage.getItem('bacnet_gateway_refresh_token')).toBeTruthy();
    });

    test('index.html references Vue 3 and runtime navigation', () => {
        const indexPath = path.join(__dirname, '..', 'web', 'index.html');
        const html = fs.readFileSync(indexPath, 'utf8');

        expect(html).toContain('https://unpkg.com/vue@3/dist/vue.global.prod.js');
        expect(html).toContain("showView('runtime')");
        expect(html).toContain("showView('runtimeObjects')");
        expect(html).toContain('id="runtime-devices-template"');
        expect(html).toContain('id="runtime-objects-template"');
    });

    test('runtime objects view loads persisted object states through the new API', async () => {
        const { context, exports } = loadAdminScript();
        const RuntimeObjects = exports.appOptions.components.RuntimeObjects;
        const component = {
            ...RuntimeObjects.data(),
            ...RuntimeObjects.methods
        };
        component.deviceId = 'Gree VRF/1';
        context.axios.get.mockResolvedValue({
            data: [{ device_id: 'Gree VRF/1', object_key: '2_202', value: 21.5 }]
        });

        await component.load();

        expect(context.axios.get).toHaveBeenCalledWith('/api/bacnet/runtime-objects/Gree%20VRF%2F1');
        expect(component.objects).toEqual([{ device_id: 'Gree VRF/1', object_key: '2_202', value: 21.5 }]);
        expect(component.loaded).toBe(true);
        expect(component.loading).toBe(false);
    });

    test('device scan annotates discovered objects with configured and runtime diagnostics', async () => {
        const { context, exports } = loadAdminScript();
        const DeviceScan = exports.appOptions.components.DeviceScan;
        const component = {
            ...DeviceScan.data(),
            ...DeviceScan.methods
        };
        component.deviceId = '1';
        component.address = '192.168.1.20';
        context.axios.put.mockResolvedValue({
            data: [
                { objectId: { type: 2, instance: 202 }, name: 'Zone Temp' },
                { objectId: { type: 3, instance: 9 }, name: 'Fan State' }
            ]
        });
        context.axios.get.mockImplementation((url) => {
            if (url === '/api/bacnet/configured') {
                return Promise.resolve({
                    data: [
                        { deviceId: '1', objects: [{ objectKey: '2_202', objectType: 2, objectInstance: 202 }] }
                    ]
                });
            }
            if (url === '/api/bacnet/runtime-objects/1') {
                return Promise.resolve({
                    data: [{ object_key: '2_202', value: 21.5, updated_at: 1000 }]
                });
            }
            return Promise.reject(new Error(`unexpected URL ${url}`));
        });

        await component.scanDevice();

        expect(context.axios.put).toHaveBeenCalledWith('/api/bacnet/1/objects', {
            deviceId: '1',
            address: '192.168.1.20'
        });
        expect(component.objects[0]).toEqual(expect.objectContaining({
            objectKey: '2_202',
            configured: true,
            runtime: true
        }));
        expect(component.objects[1]).toEqual(expect.objectContaining({
            objectKey: '3_9',
            configured: false,
            runtime: false
        }));
        expect(component.objectStatusLabels(component.objects[0])).toEqual(['Discovered', 'Configured', 'Runtime']);
        expect(DeviceScan.computed.diagnosticsSummary.call(component)).toEqual(expect.objectContaining({
            discovered: 2,
            configured: 1,
            runtime: 1,
            discoveredOnly: 1
        }));
    });

    test('device scan can load demo diagnostics data on localhost', () => {
        const { context, exports } = loadAdminScript();
        context.window.location.hostname = 'localhost';
        const DeviceScan = exports.appOptions.components.DeviceScan;
        const component = {
            ...DeviceScan.data(),
            ...DeviceScan.methods
        };

        component.loadDemoScan();

        expect(component.demoScanAvailable).toBe(true);
        expect(component.deviceId).toBe('demo-vrf-1');
        expect(component.objects).toHaveLength(3);
        expect(component.objectStatusLabels(component.objects[0])).toEqual(['Discovered', 'Configured', 'Runtime']);
        expect(component.objectStatusLabels(component.objects[1])).toEqual(['Discovered', 'Configured']);
        expect(component.objectStatusLabels(component.objects[2])).toEqual(['Discovered']);
        expect(DeviceScan.computed.diagnosticsSummary.call(component)).toEqual(expect.objectContaining({
            discovered: 3,
            configured: 2,
            runtime: 1,
            discoveredOnly: 1
        }));
        expect(component.diagnosticsExpanded).toBe(true);
    });
});
