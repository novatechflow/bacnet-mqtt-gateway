const fs = require('fs');
const os = require('os');
const path = require('path');

function writeSecureBootstrapFile(username, password) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bacnet-mqtt-gateway-admin-'));
    fs.chmodSync(dir, 0o700);
    const filePath = path.join(dir, 'initial-admin.txt');
    const body = [
        'bacnet-mqtt-gateway initial admin credentials',
        `username=${username}`,
        `password=${password}`,
        '',
        'Change this password immediately after first login.'
    ].join('\n');
    fs.writeFileSync(filePath, body, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(filePath, 0o600);
    return filePath;
}

function deliverInitialAdminPassword(username, password, io = {}) {
    const stderr = io.stderr || process.stderr;
    const isTTY = typeof io.isTTY === 'boolean' ? io.isTTY : Boolean(stderr && stderr.isTTY);
    const filePath = writeSecureBootstrapFile(username, password);

    if (stderr && typeof stderr.write === 'function') {
        if (isTTY) {
            stderr.write('\n');
            stderr.write('=== Initial Admin Credentials ===\n');
            stderr.write(`username: ${username}\n`);
            stderr.write(`password: ${password}\n`);
            stderr.write(`stored at: ${filePath} (mode 0600)\n`);
            stderr.write('Change this password immediately after first login.\n');
            stderr.write('=================================\n\n');
        } else {
            stderr.write(`[Auth] Initial admin credentials stored at ${filePath} (mode 0600)\n`);
        }
    }

    return filePath;
}

module.exports = { deliverInitialAdminPassword, writeSecureBootstrapFile };
