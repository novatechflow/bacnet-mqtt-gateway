const express = require('express');
const config = require('config');
const cors = require('cors');
const { json } = require('body-parser');
const { logger } = require('./common');
const swaggerUi = require('swagger-ui-express'); 
const YAML = require('yamljs'); 
const path = require('path'); 
const rateLimit = require('express-rate-limit');

const port = config.get('httpServer.port');
const openapiDocument = YAML.load(path.join(__dirname, '../openapi.yaml')); 

class Server {

    constructor(bacnetClient, mqttClient, authService) {

        this.bacnetClient = bacnetClient;
        this.mqttClient = mqttClient;
        this.authService = authService;
        
        this.app = express();        
        this.app.use(json());
        this.app.use(cors());
        this.app.use('/admin', express.static('web'));
        this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDocument)); 

        const authLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 30,
            standardHeaders: true,
            legacyHeaders: false
        });

        // auth routes
        this.app.post('/auth/login', authLimiter, this._login.bind(this));
        this.app.post('/auth/register', authLimiter, this._requireRole('admin'), this._register.bind(this));
        this.app.post('/auth/refresh', authLimiter, this._refresh.bind(this));
        this.app.post('/auth/change-password', authLimiter, this._requireRole('viewer'), this._changePassword.bind(this));

        // health/metrics (unauthenticated)
        this.app.get('/health', this._health.bind(this));
        this.app.get('/metrics', this._metrics.bind(this));

        // protected API
        this.app.put('/api/bacnet/scan', this._requireRole('viewer'), this._scanForDevices.bind(this));
        this.app.put('/api/bacnet/:deviceId/objects', this._requireRole('viewer'), this._scanDevice.bind(this));
        this.app.get('/api/bacnet/configured', this._requireRole('viewer'), this._listConfigured.bind(this));
        this.app.put('/api/bacnet/:deviceId/config', this._requireRole('admin'), this._configurePolling.bind(this));
        this.app.put('/api/bacnet/write', this._requireRole('admin'), this._writeProperty.bind(this)); 

        // start server
        this.app.listen(port, () => {
        });
    }

    _scanForDevices(req, res) {
        const devices = [];
        const eventListener = (device) => devices.push(device);
        this.bacnetClient.on('deviceFound', eventListener);
        this.bacnetClient.scanForDevices();
        setTimeout(() => {
            this.bacnetClient.removeListener('deviceFound', eventListener);
            res.send(devices);
        }, 5000);
    }

    _scanDevice(req, res) {
        const device = req.body;
        if (!device || device.deviceId === undefined || !device.address) {
            return res.status(400).send({ status: 'error', message: 'deviceId and address are required in request body.' });
        }
        this.bacnetClient.scanDevice(device)
            .then(deviceObjects => {
                if (req.query.saveConfig === 'true') {
                    const config = {
                        'device': device,
                        'polling': {
                            'schedule': "*/15 * * * * *"
                        },
                        'objects': deviceObjects
                    }
                    this.bacnetClient.saveConfig(config);
                    this.bacnetClient.startPolling(config.device, config.objects, config.polling.schedule);
                }
                res.send(deviceObjects);
            })
            .catch(err => {
                logger.log('error', `[API] Failed to scan device ${JSON.stringify(device)}: ${err}`);
                res.status(500).send({ status: 'error', message: 'Failed to scan device', details: err && err.message ? err.message : err });
            });
    }

    _health(_req, res) {
        const mqttStatus = this.mqttClient && this.mqttClient.getStatus ? this.mqttClient.getStatus() : { connected: false };
        const bacnetStatus = {
            configuredDevices: this.bacnetClient && this.bacnetClient.deviceConfigs ? this.bacnetClient.deviceConfigs.size : 0
        };
        const overallOk = mqttStatus.connected === true;
        res.status(200).send({
            status: overallOk ? 'ok' : 'degraded',
            mqtt: mqttStatus,
            bacnet: bacnetStatus
        });
    }

    _metrics(_req, res) {
        const mqttStatus = this.mqttClient && this.mqttClient.getStatus ? this.mqttClient.getStatus() : { connected: false };
        const configuredDevices = this.bacnetClient && this.bacnetClient.deviceConfigs ? this.bacnetClient.deviceConfigs.size : 0;
        const lines = [
            '# HELP bacnet_gateway_mqtt_connected MQTT connection state (1=connected, 0=not connected)',
            '# TYPE bacnet_gateway_mqtt_connected gauge',
            `bacnet_gateway_mqtt_connected ${mqttStatus.connected ? 1 : 0}`,
            '# HELP bacnet_gateway_configured_devices Count of BACnet devices configured for polling',
            '# TYPE bacnet_gateway_configured_devices gauge',
            `bacnet_gateway_configured_devices ${configuredDevices}`
        ];
        res.type('text/plain').send(lines.join('\n'));
    }

    _listConfigured(_req, res) {
        const list = [];
        if (this.bacnetClient && this.bacnetClient.deviceConfigs) {
            for (const [deviceId, cfg] of this.bacnetClient.deviceConfigs.entries()) {
                list.push({
                    deviceId,
                    address: cfg.device && cfg.device.address,
                    schedule: cfg.polling && cfg.polling.schedule,
                    objectCount: Array.isArray(cfg.objects) ? cfg.objects.length : 0
                });
            }
        }
        res.send(list);
    }

    _configurePolling(req, res) {
        const config = req.body;
        const validationErrors = [];

        if (!config || !config.device || config.device.deviceId === undefined || !config.device.address) {
            validationErrors.push('device.deviceId and device.address are required.');
        }
        if (!config || !config.polling || !config.polling.schedule) {
            validationErrors.push('polling.schedule is required.');
        }
        if (!config || !Array.isArray(config.objects) || config.objects.length === 0) {
            validationErrors.push('objects must be a non-empty array.');
        } else {
            config.objects.forEach((obj, idx) => {
                if (!obj || !obj.objectId || obj.objectId.type === undefined || obj.objectId.instance === undefined) {
                    validationErrors.push(`objects[${idx}].objectId.type and objectId.instance are required.`);
                }
            });
        }

        if (validationErrors.length > 0) {
            return res.status(400).send({ status: 'error', message: 'Invalid configuration', details: validationErrors });
        }

        try {
            this.bacnetClient.saveConfig(config);
            this.bacnetClient.startPolling(config.device, config.objects, config.polling.schedule);
            res.send({});
        } catch (err) {
            logger.log('error', `[API] Failed to configure polling: ${err}`);
            res.status(500).send({ status: 'error', message: 'Failed to configure polling', details: err && err.message ? err.message : err });
        }
    }

    async _writeProperty(req, res) {
        const {
            deviceId, // This is the key from your device config files (e.g., "114", "baspi1")
            objectType,
            objectInstance,
            propertyId,
            value,
            priority,
            bacnetApplicationTag
        } = req.body;

        if (deviceId === undefined || objectType === undefined || objectInstance === undefined || propertyId === undefined || value === undefined) {
            return res.status(400).send({ status: 'error', message: 'Missing required fields: deviceId, objectType, objectInstance, propertyId, value' });
        }
        if (typeof value === 'object' && value !== null) {
            return res.status(400).send({ status: 'error', message: 'value must be a primitive type (string/number/boolean).' });
        }
        if (priority !== undefined && (isNaN(parseInt(priority, 10)) || priority < 1 || priority > 16)) {
            return res.status(400).send({ status: 'error', message: 'priority must be a number between 1 and 16.' });
        }
        if (bacnetApplicationTag !== undefined && isNaN(parseInt(bacnetApplicationTag, 10))) {
            return res.status(400).send({ status: 'error', message: 'bacnetApplicationTag must be numeric if provided.' });
        }

        const deviceConfig = this.bacnetClient.deviceConfigs.get(deviceId.toString());

        if (!deviceConfig || !deviceConfig.device || !deviceConfig.device.address) {
            return res.status(404).send({ status: 'error', message: `Device configuration not found for deviceId: ${deviceId}` });
        }

        const deviceAddress = deviceConfig.device.address;
        const bacnetObjectId = { type: parseInt(objectType, 10), instance: parseInt(objectInstance, 10) };
        const propIdToUse = parseInt(propertyId, 10);
        const appTagToUse = bacnetApplicationTag !== undefined ? parseInt(bacnetApplicationTag, 10) : undefined;
        const priorityToUse = priority !== undefined ? parseInt(priority, 10) : undefined;

        if (isNaN(bacnetObjectId.type) || isNaN(bacnetObjectId.instance) || isNaN(propIdToUse)) {
            return res.status(400).send({ status: 'error', message: 'objectType, objectInstance, and propertyId must be numbers.' });
        }
        if (priorityToUse !== undefined && (isNaN(priorityToUse) || priorityToUse < 1 || priorityToUse > 16)) {
            return res.status(400).send({ status: 'error', message: 'priority must be a number between 1 and 16.' });
        }
         if (appTagToUse !== undefined && isNaN(appTagToUse)) {
            return res.status(400).send({ status: 'error', message: 'bacnetApplicationTag must be a number.' });
        }


        try {
            const writeResponse = await this.bacnetClient.writeProperty(
                deviceAddress,
                bacnetObjectId,
                propIdToUse,
                value,
                priorityToUse,
                appTagToUse
            );
            res.status(200).send({ status: 'success', message: 'Write operation successful', response: writeResponse });
        } catch (error) {
            logger.log('error', `[API Write] Failed for DeviceId ${deviceId}: ${error.message || error}`);
            res.status(500).send({ status: 'error', message: `BACnet write operation failed: ${error.message || error}`, details: error });
        }
    }

    async _login(req, res) {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).send({ status: 'error', message: 'username and password required' });
        }
        try {
            const user = await this.authService.validateUser(username, password);
            if (!user) {
                return res.status(401).send({ status: 'error', message: 'Invalid credentials' });
            }
            const token = this.authService.generateToken(user);
            const refreshToken = await this.authService.generateRefreshToken(user.id);
            res.send({ status: 'success', token, refreshToken, role: user.role, username: user.username });
        } catch (err) {
            logger.log('error', `[Auth] Login failed: ${err}`);
            res.status(500).send({ status: 'error', message: 'Login failed' });
        }
    }

    async _register(req, res) {
        const { username, password, role } = req.body;
        if (!username || !password) {
            return res.status(400).send({ status: 'error', message: 'username and password required' });
        }
        try {
            const user = await this.authService.createUser(username, password, role || 'viewer');
            res.status(201).send({ status: 'success', user: { id: user.id, username: user.username, role: user.role } });
        } catch (err) {
            logger.log('error', `[Auth] Register failed: ${err}`);
            res.status(400).send({ status: 'error', message: 'Register failed', details: err.message || err });
        }
    }

    async _refresh(req, res) {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).send({ status: 'error', message: 'refreshToken required' });
        }
        try {
            const newRefresh = await this.authService.rotateRefreshToken(refreshToken);
            const stored = await this.authService._getRefreshToken(newRefresh);
            const user = await this.authService.findUserById(stored.user_id);
            const access = this.authService.generateToken(user);
            res.send({ status: 'success', token: access, refreshToken: newRefresh });
        } catch (err) {
            logger.log('warn', `[Auth] Refresh failed: ${err}`);
            res.status(401).send({ status: 'error', message: 'Invalid or expired refresh token' });
        }
    }

    async _changePassword(req, res) {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).send({ status: 'error', message: 'oldPassword and newPassword required' });
        }
        try {
            await this.authService.changePassword(req.user.sub, oldPassword, newPassword);
            res.send({ status: 'success', message: 'Password updated' });
        } catch (err) {
            res.status(400).send({ status: 'error', message: err.message || 'Failed to change password' });
        }
    }

    _requireRole(minRole) {
        return async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization || '';
                const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
                if (!token) {
                    return res.status(401).send({ status: 'error', message: 'Missing token' });
                }
                const payload = await this.authService.verifyToken(token);
                if (!this.authService.hasRequiredRole(payload.role, minRole)) {
                    return res.status(403).send({ status: 'error', message: 'Forbidden' });
                }
                req.user = payload;
                next();
            } catch (err) {
                logger.log('warn', `[Auth] Unauthorized: ${err.message || err}`);
                res.status(401).send({ status: 'error', message: 'Unauthorized' });
            }
        };
    }
}

module.exports = {Server};
