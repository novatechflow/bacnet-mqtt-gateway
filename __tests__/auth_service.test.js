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

    test('createUser rejects invalid role', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();

        await expect(service.createUser('mallory', 'secret', 'owner')).rejects.toThrow('Invalid role');
    });

    test('rotateRefreshToken rejects expired token', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('erin', 'secret', 'viewer');
        const refresh = await service.generateRefreshToken(user.id);

        await new Promise((resolve, reject) => {
            service.db.run(
                'UPDATE refresh_tokens SET expires_at = ? WHERE token = ?',
                [Date.now() - 1000, refresh],
                (err) => (err ? reject(err) : resolve())
            );
        });

        await expect(service.rotateRefreshToken(refresh)).rejects.toThrow('Refresh token expired');
    });

    test('changePassword rejects wrong old password and missing user', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('frank', 'secret', 'viewer');

        await expect(service.changePassword(user.id, 'wrong', 'newpass')).rejects.toThrow('Invalid old password');
        await expect(service.changePassword(999999, 'secret', 'newpass')).rejects.toThrow('User not found');
    });

    test('hasRequiredRole enforces role ordering', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();

        expect(service.hasRequiredRole('admin', 'viewer')).toBe(true);
        expect(service.hasRequiredRole('viewer', 'admin')).toBe(false);
    });

    test('findUser and findUserById return null for unknown users', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();

        await expect(service.findUser('missing')).resolves.toBeNull();
        await expect(service.findUserById(424242)).resolves.toBeNull();
    });

    test('validateUser returns null for unknown user and wrong password', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        await service.createUser('gina', 'secret', 'viewer');

        await expect(service.validateUser('missing', 'secret')).resolves.toBeNull();
        await expect(service.validateUser('gina', 'wrong')).resolves.toBeNull();
    });

    test('rotateRefreshToken rejects invalid token', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();

        await expect(service.rotateRefreshToken('missing-token')).rejects.toThrow('Invalid refresh token');
    });

    test('verifyToken rejects tampered token', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();

        await expect(service.verifyToken('not-a-token')).rejects.toBeTruthy();
    });

    test('setPassword updates credentials without old password flow', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        await service.init();
        const user = await service.createUser('henry', 'secret', 'viewer');

        await service.setPassword(user.id, 'new-secret');

        await expect(service.validateUser('henry', 'secret')).resolves.toBeNull();
        await expect(service.validateUser('henry', 'new-secret')).resolves.toBeTruthy();
    });

    test('resetAdminPassword rotates existing admin and recreates missing admin', async () => {
        const { AuthService } = require('../src/auth_service');
        const service = new AuthService();
        const firstPassword = await service.init();

        const rotatedPassword = await service.resetAdminPassword('admin');
        expect(rotatedPassword).toBeTruthy();
        expect(rotatedPassword).not.toBe(firstPassword);
        await expect(service.validateUser('admin', rotatedPassword)).resolves.toBeTruthy();
        await expect(service.validateUser('admin', firstPassword)).resolves.toBeNull();

        await new Promise((resolve, reject) => {
            service.db.run(
                'DELETE FROM users WHERE username = ?',
                ['admin'],
                (err) => (err ? reject(err) : resolve())
            );
        });

        const recreatedPassword = await service.resetAdminPassword('admin');
        const recreatedAdmin = await service.validateUser('admin', recreatedPassword);
        expect(recreatedAdmin).toBeTruthy();
        expect(recreatedAdmin.role).toBe('admin');
    });
});
