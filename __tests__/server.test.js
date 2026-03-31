describe('Server helper methods', () => {
    let Server;
    let expressApp;
    let rateLimitMock;

    beforeEach(() => {
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            httpServer: { port: 8082 }
        });
        jest.resetModules();
        jest.doMock('express', () => {
            expressApp = {
                use: jest.fn(),
                post: jest.fn(),
                get: jest.fn(),
                put: jest.fn(),
                listen: jest.fn()
            };
            const express = () => expressApp;
            express.static = jest.fn(() => jest.fn());
            return express;
        });
        jest.doMock('cors', () => jest.fn(() => jest.fn()));
        jest.doMock('body-parser', () => ({ json: jest.fn(() => jest.fn()) }));
        jest.doMock('swagger-ui-express', () => ({ serve: jest.fn(), setup: jest.fn(() => jest.fn()) }));
        jest.doMock('yamljs', () => ({ load: jest.fn(() => ({})) }));
        jest.doMock('express-rate-limit', () => {
            rateLimitMock = jest.fn(() => jest.fn());
            return rateLimitMock;
        });
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

    test('constructor wires routes and starts listening', () => {
        const bacnetClient = {};
        const mqttClient = {};
        const authService = {};

        new Server(bacnetClient, mqttClient, authService);

        expect(rateLimitMock).toHaveBeenCalledWith(expect.objectContaining({
            windowMs: 15 * 60 * 1000,
            max: 30
        }));
        expect(rateLimitMock).toHaveBeenCalledWith(expect.objectContaining({
            windowMs: 60 * 1000,
            max: 120
        }));
        expect(expressApp.post).toHaveBeenCalledWith('/auth/login', expect.any(Function), expect.any(Function));
        expect(expressApp.get).toHaveBeenCalledWith('/health', expect.any(Function));
        expect(expressApp.get).toHaveBeenCalledWith('/metrics', expect.any(Function));
        expect(expressApp.put).toHaveBeenCalledWith('/api/bacnet/write', expect.any(Function), expect.any(Function), expect.any(Function));
        expect(expressApp.listen).toHaveBeenCalledWith(8082, expect.any(Function));
        expressApp.listen.mock.calls[0][1]();
    });

    test('scanForDevices collects discovered devices and responds after timeout', () => {
        jest.useFakeTimers();
        const { EventEmitter } = require('events');
        const bacnetClient = new EventEmitter();
        bacnetClient.scanForDevices = jest.fn(() => {
            bacnetClient.emit('deviceFound', { deviceId: 1, address: '10.0.0.1' });
            bacnetClient.emit('deviceFound', { deviceId: 2, address: '10.0.0.2' });
        });
        const removeListenerSpy = jest.spyOn(bacnetClient, 'removeListener');
        const server = Object.create(Server.prototype);
        server.bacnetClient = bacnetClient;
        const res = createResponse();

        server._scanForDevices({}, res);
        jest.advanceTimersByTime(5000);

        expect(bacnetClient.scanForDevices).toHaveBeenCalled();
        expect(removeListenerSpy).toHaveBeenCalledWith('deviceFound', expect.any(Function));
        expect(res.payload).toEqual([
            { deviceId: 1, address: '10.0.0.1' },
            { deviceId: 2, address: '10.0.0.2' }
        ]);
        jest.useRealTimers();
    });

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

    test('listRuntime returns 500 on runtime state failure', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            listRuntimeStates: jest.fn().mockRejectedValue(new Error('db down'))
        };
        const res = createResponse();

        await server._listRuntime({}, res);

        expect(res.statusCode).toBe(500);
        expect(res.payload.message).toBe('Failed to fetch runtime states');
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

    test('writeProperty validates payload before BACnet write', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            deviceConfigs: new Map([['114', { device: { address: '192.168.1.10' } }]]),
            writeProperty: jest.fn()
        };
        const res = createResponse();

        await server._writeProperty({
            body: { deviceId: '114', objectType: 'bad', objectInstance: 0, propertyId: 85, value: 1 }
        }, res);

        expect(res.statusCode).toBe(400);
        expect(server.bacnetClient.writeProperty).not.toHaveBeenCalled();
    });

    test('writeProperty returns 500 on BACnet write failure', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            deviceConfigs: new Map([['114', { device: { address: '192.168.1.10' } }]]),
            writeProperty: jest.fn().mockRejectedValue(new Error('write failed'))
        };
        const res = createResponse();

        await server._writeProperty({
            body: { deviceId: '114', objectType: 1, objectInstance: 0, propertyId: 85, value: 1 }
        }, res);

        expect(res.statusCode).toBe(500);
        expect(res.payload.message).toContain('write failed');
    });

    test('writeProperty accepts valid priority and application tag', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            deviceConfigs: new Map([['114', { device: { address: '192.168.1.10' } }]]),
            writeProperty: jest.fn().mockResolvedValue({ ok: true })
        };
        const res = createResponse();

        await server._writeProperty({
            body: {
                deviceId: '114',
                objectType: '1',
                objectInstance: '0',
                propertyId: '85',
                value: 1,
                priority: '8',
                bacnetApplicationTag: '4'
            }
        }, res);

        expect(server.bacnetClient.writeProperty).toHaveBeenCalledWith(
            '192.168.1.10',
            { type: 1, instance: 0 },
            85,
            1,
            8,
            4
        );
        expect(res.statusCode).toBe(200);
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

    test('login validates required fields and invalid credentials', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            validateUser: jest.fn().mockResolvedValue(null)
        };

        const missingRes = createResponse();
        await server._login({ body: { username: 'admin' } }, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const invalidRes = createResponse();
        await server._login({ body: { username: 'admin', password: 'bad' } }, invalidRes);
        expect(invalidRes.statusCode).toBe(401);
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

    test('refresh requires token and returns 401 on rotation failure', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            rotateRefreshToken: jest.fn().mockRejectedValue(new Error('bad token'))
        };

        const missingRes = createResponse();
        await server._refresh({ body: {} }, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const invalidRes = createResponse();
        await server._refresh({ body: { refreshToken: 'bad' } }, invalidRes);
        expect(invalidRes.statusCode).toBe(401);
    });

    test('changePassword validates required fields', async () => {
        const server = Object.create(Server.prototype);
        server.authService = { changePassword: jest.fn() };
        const res = createResponse();

        await server._changePassword({ body: {}, user: { sub: 1 } }, res);

        expect(res.statusCode).toBe(400);
    });

    test('changePassword returns success and service errors', async () => {
        const server = Object.create(Server.prototype);
        server.authService = { changePassword: jest.fn() };

        const okRes = createResponse();
        await server._changePassword({
            body: { oldPassword: 'old', newPassword: 'new' },
            user: { sub: 1 }
        }, okRes);
        expect(okRes.payload).toEqual({ status: 'success', message: 'Password updated' });

        server.authService.changePassword.mockRejectedValueOnce(new Error('Invalid old password'));
        const errRes = createResponse();
        await server._changePassword({
            body: { oldPassword: 'old', newPassword: 'new' },
            user: { sub: 1 }
        }, errRes);
        expect(errRes.statusCode).toBe(400);
        expect(errRes.payload.message).toBe('Invalid old password');
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

    test('requireRole rejects missing and invalid tokens and accepts authorized token', async () => {
        const server = Object.create(Server.prototype);
        const next = jest.fn();

        server.authService = {
            verifyToken: jest.fn().mockRejectedValue(new Error('invalid token')),
            hasRequiredRole: jest.fn().mockReturnValue(true)
        };

        const missingRes = createResponse();
        await server._requireRole('viewer')({ headers: {} }, missingRes, next);
        expect(missingRes.statusCode).toBe(401);

        const invalidRes = createResponse();
        await server._requireRole('viewer')({
            headers: { authorization: 'Bearer broken' }
        }, invalidRes, next);
        expect(invalidRes.statusCode).toBe(401);

        server.authService.verifyToken.mockResolvedValueOnce({ sub: 3, role: 'admin' });
        const req = { headers: { authorization: 'Bearer ok' } };
        const okRes = createResponse();
        await server._requireRole('viewer')(req, okRes, next);
        expect(req.user).toEqual({ sub: 3, role: 'admin' });
        expect(next).toHaveBeenCalled();
    });

    test('scanDevice validates payload, saves config, and handles failure', async () => {
        const server = Object.create(Server.prototype);
        server.bacnetClient = {
            scanDevice: jest.fn()
                .mockResolvedValueOnce([{ objectId: { type: 2, instance: 202 } }])
                .mockRejectedValueOnce(new Error('scan failed')),
            saveConfig: jest.fn(),
            startPolling: jest.fn()
        };

        const invalidRes = createResponse();
        server._scanDevice({ body: {}, query: {} }, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        const saveRes = createResponse();
        server._scanDevice({
            body: { deviceId: 114, address: '192.168.1.10' },
            query: { saveConfig: 'true' }
        }, saveRes);
        await new Promise((resolve) => setImmediate(resolve));
        expect(server.bacnetClient.saveConfig).toHaveBeenCalled();
        expect(server.bacnetClient.startPolling).toHaveBeenCalled();
        expect(saveRes.payload).toEqual([{ objectId: { type: 2, instance: 202 } }]);

        const errRes = createResponse();
        server._scanDevice({
            body: { deviceId: 115, address: '192.168.1.11' },
            query: {}
        }, errRes);
        await new Promise((resolve) => setImmediate(resolve));
        expect(errRes.statusCode).toBe(500);
        expect(errRes.payload.message).toBe('Failed to scan device');
    });

    test('register validates required fields and returns created user', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            createUser: jest.fn().mockResolvedValue({ id: 4, username: 'new-user', role: 'viewer' })
        };

        const missingRes = createResponse();
        await server._register({ body: { username: 'new-user' } }, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const okRes = createResponse();
        await server._register({ body: { username: 'new-user', password: 'secret' } }, okRes);
        expect(okRes.statusCode).toBe(201);
        expect(okRes.payload.user.username).toBe('new-user');
    });

    test('register returns 400 when user creation fails', async () => {
        const server = Object.create(Server.prototype);
        server.authService = {
            createUser: jest.fn().mockRejectedValue(new Error('duplicate username'))
        };
        const res = createResponse();

        await server._register({ body: { username: 'existing', password: 'secret' } }, res);

        expect(res.statusCode).toBe(400);
        expect(res.payload.details).toBe('duplicate username');
    });
});
