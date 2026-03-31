#!/usr/bin/env node

require('dotenv').config();

const { AuthService } = require('../src/auth_service');
const { deliverInitialAdminPassword } = require('../src/bootstrap_credentials');

async function main() {
    const authService = new AuthService();

    try {
        await authService.init();
        const password = await authService.resetAdminPassword('admin');
        deliverInitialAdminPassword('admin', password);
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        process.stderr.write(`[Auth] Failed to reset admin password: ${message}\n`);
        process.exit(1);
    }
}

main();
