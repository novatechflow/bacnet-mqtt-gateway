const fs = require('fs');
const os = require('os');
const path = require('path');

describe('AuthService', () => {
    let tempDir;
    let dbPath;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdb-'));
        dbPath = path.join(tempDir, 'auth.db');
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            auth: {
                dbPath,
                jwtSecret: 'test-secret',
                tokenExpiresIn: '1h'
            }
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

    test('seeds admin with random password and validates login', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        const seedPassword = await service.init();

        expect(seedPassword).toBeTruthy();
        const admin = await service.validateUser('admin', seedPassword);
        expect(admin).toBeTruthy();

        const token = service.generateToken(admin);
        const payload = await service.verifyToken(token);
        expect(payload.username).toBe('admin');
        expect(payload.role).toBe('admin');
    });

    test('createUser adds viewer', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('bob', 'secret', 'viewer');
        expect(user.username).toBe('bob');
        const validated = await service.validateUser('bob', 'secret');
        expect(validated).toBeTruthy();
    });

    test('refresh token rotation', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('carol', 'secret', 'viewer');
        const refresh = await service.generateRefreshToken(user.id);
        const newRefresh = await service.rotateRefreshToken(refresh);
        expect(newRefresh).toBeTruthy();
    });

    test('change password with old password', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('dave', 'oldpass', 'viewer');
        await service.changePassword(user.id, 'oldpass', 'newpass');
        const validated = await service.validateUser('dave', 'newpass');
        expect(validated).toBeTruthy();
    });
});
