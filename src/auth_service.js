const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('config');
const { logger } = require('./common');
const path = require('path');
const fs = require('fs');

const ROLE_ORDER = {
    viewer: 1,
    admin: 2
};

class AuthService {
    constructor() {
        const authCfg = config.get('auth');
        this.dbPath = path.resolve(authCfg.dbPath || './data/auth.db');
        this.jwtSecret = authCfg.jwtSecret;
        this.tokenExpiresIn = authCfg.tokenExpiresIn || '1h';
        this.refreshTokenExpiresHours = authCfg.refreshTokenExpiresHours || 168; // 7 days
        this.db = null;
        this.initialAdminPassword = null;
    }

    async init() {
        await this._openDb();
        await this._migrate();
        await this._seedAdmin();
        return this.initialAdminPassword;
    }

    _openDb() {
        return new Promise((resolve, reject) => {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    logger.log('error', `[Auth] Failed to open DB at ${this.dbPath}: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    _migrate() {
        return new Promise((resolve, reject) => {
            const sql = `
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    role TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
            `;
            this.db.exec(sql, (err) => {
                if (err) {
                    logger.log('error', `[Auth] Migration failed: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    _seedAdmin() {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM users', async (err, row) => {
                if (err) {
                    logger.log('error', `[Auth] Failed to count users: ${err}`);
                    reject(err);
                    return;
                }
                if (row.count > 0) {
                    resolve();
                    return;
                }
                const password = crypto.randomBytes(12).toString('base64url');
                const hash = await bcrypt.hash(password, 10);
                this.db.run(
                    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
                    ['admin', hash, 'admin'],
                    (insertErr) => {
                        if (insertErr) {
                            logger.log('error', `[Auth] Failed to seed admin user: ${insertErr}`);
                            reject(insertErr);
                        } else {
                            this.initialAdminPassword = password;
                            logger.log('info', `[Auth] Seeded admin user with random password: ${password}`);
                            resolve();
                        }
                    }
                );
            });
        });
    }

    createUser(username, password, role = 'viewer') {
        return new Promise(async (resolve, reject) => {
            if (!ROLE_ORDER[role]) {
                return reject(new Error('Invalid role'));
            }
            const hash = await bcrypt.hash(password, 10);
            this.db.run(
                'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
                [username, hash, role],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ id: this.lastID, username, role });
                    }
                }
            );
        });
    }

    findUser(username) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    findUserById(id) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async validateUser(username, password) {
        const user = await this.findUser(username);
        if (!user) return null;
        const match = await bcrypt.compare(password, user.password);
        return match ? user : null;
    }

    generateToken(user) {
        return jwt.sign(
            { sub: user.id, role: user.role, username: user.username },
            this.jwtSecret,
            { expiresIn: this.tokenExpiresIn }
        );
    }

    async generateRefreshToken(userId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + this.refreshTokenExpiresHours * 60 * 60 * 1000;
        await this._insertRefreshToken(token, userId, expiresAt);
        return token;
    }

    _insertRefreshToken(token, userId, expiresAt) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
                [token, userId, expiresAt],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    async rotateRefreshToken(oldToken) {
        const stored = await this._getRefreshToken(oldToken);
        if (!stored) {
            throw new Error('Invalid refresh token');
        }
        if (stored.expires_at < Date.now()) {
            await this._deleteRefreshToken(oldToken);
            throw new Error('Refresh token expired');
        }
        await this._deleteRefreshToken(oldToken);
        return this.generateRefreshToken(stored.user_id);
    }

    _getRefreshToken(token) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM refresh_tokens WHERE token = ?', [token], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    _deleteRefreshToken(token) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM refresh_tokens WHERE token = ?', [token], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    verifyToken(token) {
        return new Promise((resolve, reject) => {
            jwt.verify(token, this.jwtSecret, (err, payload) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(payload);
                }
            });
        });
    }

    hasRequiredRole(userRole, minRole) {
        return ROLE_ORDER[userRole] >= ROLE_ORDER[minRole];
    }

    async changePassword(userId, oldPassword, newPassword) {
        const user = await this.findUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) {
            throw new Error('Invalid old password');
        }
        const hash = await bcrypt.hash(newPassword, 10);
        return new Promise((resolve, reject) => {
            this.db.run('UPDATE users SET password = ? WHERE id = ?', [hash, userId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}

module.exports = { AuthService, ROLE_ORDER };
