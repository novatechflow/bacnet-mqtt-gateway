const fs = require('fs');

describe('bootstrap credentials delivery', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('writes credentials to a 0600 file and avoids printing password in non-tty mode', () => {
        const stderr = { write: jest.fn(), isTTY: false };
        const { deliverInitialAdminPassword } = require('../src/bootstrap_credentials');

        const filePath = deliverInitialAdminPassword('admin', 'super-secret', { stderr, isTTY: false });
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const mode = fs.statSync(filePath).mode & 0o777;

        expect(fileContent).toContain('username=admin');
        expect(fileContent).toContain('password=super-secret');
        expect(mode).toBe(0o600);
        expect(stderr.write).toHaveBeenCalledWith(
            expect.stringContaining(`Initial admin credentials stored at ${filePath}`)
        );
        expect(stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('super-secret'));

        fs.rmSync(filePath, { force: true });
        fs.rmSync(require('path').dirname(filePath), { recursive: true, force: true });
    });

    test('prints password directly to tty users instead of structured logs', () => {
        const stderr = { write: jest.fn(), isTTY: true };
        const { deliverInitialAdminPassword } = require('../src/bootstrap_credentials');

        const filePath = deliverInitialAdminPassword('admin', 'visible-once', { stderr, isTTY: true });

        expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('=== Initial Admin Credentials ===\n'));
        expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('password: visible-once'));

        fs.rmSync(filePath, { force: true });
        fs.rmSync(require('path').dirname(filePath), { recursive: true, force: true });
    });
});
