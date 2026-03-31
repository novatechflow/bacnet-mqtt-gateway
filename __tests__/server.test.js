describe('Server helper methods', () => {
    let Server;

    beforeEach(() => {
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            httpServer: { port: 8082 }
        });
        jest.resetModules();
        jest.doMock('express', () => {
            const app = {
                use: jest.fn(),
                post: jest.fn(),
                get: jest.fn(),
                put: jest.fn(),
                listen: jest.fn()
            };
            const express = () => app;
            express.static = jest.fn(() => jest.fn());
            return express;
        });
        jest.doMock('cors', () => jest.fn(() => jest.fn()));
        jest.doMock('body-parser', () => ({ json: jest.fn(() => jest.fn()) }));
        jest.doMock('swagger-ui-express', () => ({ serve: jest.fn(), setup: jest.fn(() => jest.fn()) }));
        jest.doMock('yamljs', () => ({ load: jest.fn(() => ({})) }));
        jest.doMock('express-rate-limit', () => jest.fn(() => jest.fn()));
        jest.doMock('../src/common', () => ({
            logger: { log: jest.fn() }
        }));
        Server = require('../src/server').Server;
    });

    afterEach(() => {
        delete process.env.NODE_CONFIG;
        delete process.env.NODE_ENV;
        delete process.env.NODE_CONFIG_STRICT_MODE;
        jest.resetModules();
    });

    function createResponse() {
        return {
            statusCode: 200,
            payload: null,
            headers: {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.payload = body;
                return this;
            },
            type(value) {
                this.headers['content-type'] = value;
                return this;
            }
        };
    }

    test('health includes runtime summary and degraded status', async () => {
        const server = Object.create(Server.prototype);
        server.mqttClient = {
            getStatus: () => ({ connected: false, publishSuccessCount: 5, publishFailureCount: 1 })
        };
        server.bacnetClient = {
            getStatus: () => ({ configuredDevices: 2, queuedPolls: 1 }),
            runtimeState: {
                getMetricsSummary: jest.fn().mockResolvedValue({
                    configuredDevices: 2,
                    healthyDevices: 1,
                    degradedDevices: 1,
                    openCircuits: 1,
                    staleObjects: 4
                })
            }
        };
        const res = createResponse();

        await server._health({}, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.status).toBe('degraded');
        expect(res.payload.runtime.openCircuits).toBe(1);
    });

    test('metrics exports polling and runtime gauges', async () => {
        const server = Object.create(Server.prototype);
        server.mqttClient = {
            getStatus: () => ({ connected: true, publishSuccessCount: 7, publishFailureCount: 2 })
        };
        server.bacnetClient = {
            getStatus: () => ({
                queuedPolls: 3,
                queueHighWaterMark: 8,
                totalPolls: 10,
                failedPolls: 2,
                totalObjectsRead: 20,
                totalObjectFailures: 3,
                avgPollDurationMs: 45
            }),
            runtimeState: {
                getMetricsSummary: jest.fn().mockResolvedValue({
                    configuredDevices: 4,
                    healthyDevices: 3,
                    degradedDevices: 1,
                    openCircuits: 1,
                    staleObjects: 6
                })
            }
        };
        const res = createResponse();

        await server._metrics({}, res);

        expect(res.headers['content-type']).toBe('text/plain');
        expect(res.payload).toContain('bacnet_gateway_open_circuits 1');
        expect(res.payload).toContain('bacnet_gateway_poll_total 10');
        expect(res.payload).toContain('bacnet_gateway_mqtt_publish_success_total 7');
    });

    test('configure polling accepts class-based polling config', () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            saveConfig: jest.fn(),
            startPolling: jest.fn()
        };
        const req = {
            body: {
                device: { deviceId: 114, address: '192.168.1.10' },
                polling: { class: 'fast', freshnessMs: 5000 },
                objects: [{ objectId: { type: 2, instance: 202 } }]
            }
        };
        const res = createResponse();

        server._configurePolling(req, res);

        expect(server.bacnetClient.saveConfig).toHaveBeenCalled();
        expect(server.bacnetClient.startPolling).toHaveBeenCalledWith(
            req.body.device,
            req.body.objects,
            req.body.polling
        );
        expect(res.payload).toEqual({});
    });

    test('listConfigured returns polling metadata', () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            deviceConfigs: new Map([[
                '114',
                {
                    device: { address: '192.168.1.10' },
                    polling: { schedule: '*/15 * * * * *', class: 'fast', intervalMs: 1000, freshnessMs: 2000 },
                    objects: [{ objectId: { type: 2, instance: 202 } }]
                }
            ]])
        };
        const res = createResponse();

        server._listConfigured({}, res);

        expect(res.payload[0]).toMatchObject({
            deviceId: '114',
            pollClass: 'fast',
            intervalMs: 1000,
            freshnessMs: 2000,
            objectCount: 1
        });
    });

    test('listRuntime returns persisted runtime states', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            listRuntimeStates: jest.fn().mockResolvedValue([{ device_id: '114', circuit_state: 'closed' }])
        };
        const res = createResponse();

        await server._listRuntime({}, res);

        expect(res.payload).toEqual([{ device_id: '114', circuit_state: 'closed' }]);
    });

    test('configure polling rejects invalid payload', () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            saveConfig: jest.fn(),
            startPolling: jest.fn()
        };
        const req = {
            body: {
                device: { deviceId: 114 },
                polling: { intervalMs: -1 },
                objects: []
            }
        };
        const res = createResponse();

        server._configurePolling(req, res);

        expect(res.statusCode).toBe(400);
        expect(server.bacnetClient.saveConfig).not.toHaveBeenCalled();
        expect(res.payload.details).toEqual(expect.arrayContaining([
            expect.stringContaining('device.address'),
            expect.stringContaining('intervalMs'),
            expect.stringContaining('objects')
        ]));
    });

    test('writeProperty returns 404 when device config is missing', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            deviceConfigs: new Map(),
            writeProperty: jest.fn()
        };
        const res = createResponse();

        await server._writeProperty({
            body: { deviceId: 'x', objectType: 1, objectInstance: 0, propertyId: 85, value: 1 }
        }, res);

        expect(res.statusCode).toBe(404);
    });

    test('login returns token pair for valid credentials', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            validateUser: jest.fn().mockResolvedValue({ id: 1, username: 'admin', role: 'admin' }),
            generateToken: jest.fn().mockReturnValue('jwt'),
            generateRefreshToken: jest.fn().mockResolvedValue('refresh')
        };
        const res = createResponse();

        await server._login({ body: { username: 'admin', password: 'secret' } }, res);

        expect(res.payload).toMatchObject({ status: 'success', token: 'jwt', refreshToken: 'refresh' });
    });

    test('refresh rotates refresh token and returns new access token', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            rotateRefreshToken: jest.fn().mockResolvedValue('new-refresh'),
            _getRefreshToken: jest.fn().mockResolvedValue({ user_id: 2 }),
            findUserById: jest.fn().mockResolvedValue({ id: 2, username: 'viewer', role: 'viewer' }),
            generateToken: jest.fn().mockReturnValue('new-jwt')
        };
        const res = createResponse();

        await server._refresh({ body: { refreshToken: 'old' } }, res);

        expect(res.payload).toEqual({ status: 'success', token: 'new-jwt', refreshToken: 'new-refresh' });
    });

    test('changePassword validates required fields', async () => {
        const server = Object.create(Server.prototype);
        server.authService = { changePassword: jest.fn() };
        const res = createResponse();

        await server._changePassword({ body: {}, user: { sub: 1 } }, res);

        expect(res.statusCode).toBe(400);
    });

    test('requireRole returns 403 for insufficient role', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            verifyToken: jest.fn().mockResolvedValue({ role: 'viewer' }),
            hasRequiredRole: jest.fn().mockReturnValue(false)
        };
        const res = createResponse();
        const next = jest.fn();

        await server._requireRole('admin')({
            headers: { authorization: 'Bearer token' }
        }, res, next);

        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });
});
