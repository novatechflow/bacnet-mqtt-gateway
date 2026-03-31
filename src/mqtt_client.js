const mqtt = require('mqtt');
const config = require('config');
const fs = require('fs');
const EventEmitter = require('events');
const { logger } = require('./common');

const gatewayId = config.get('mqtt.gatewayId');
const host = config.get('mqtt.host');
const port = config.get('mqtt.port');
const username = config.get('mqtt.username');
const password = config.get('mqtt.password');
const tlsConfigRaw = config.has('mqtt.tls') ? config.get('mqtt.tls') : {};
const tlsConfig = {
    enabled: tlsConfigRaw.enabled === true || tlsConfigRaw.enabled === 'true',
    caPath: tlsConfigRaw.caPath,
    certPath: tlsConfigRaw.certPath,
    keyPath: tlsConfigRaw.keyPath,
    rejectUnauthorized: typeof tlsConfigRaw.rejectUnauthorized === 'string'
        ? tlsConfigRaw.rejectUnauthorized !== 'false'
        : tlsConfigRaw.rejectUnauthorized
};

class MqttClient extends EventEmitter {
    constructor() {
        super();

        this.connected = false;
        this.lastError = null;
        this.publishSuccessCount = 0;
        this.publishFailureCount = 0;
        this.lastPublishedAt = null;

        const options = {
            host,
            port,
            protocol: tlsConfig.enabled ? 'mqtts' : 'mqtt',
            username,
            password
        };

        this._applyTlsOptions(options);
        this.client = mqtt.connect(options);

        this.client.on('connect', () => {
            this._onConnect();
        });

        this.client.on('error', (error) => {
            this.lastError = error.message;
            this.connected = false;
            logger.log('error', `[MQTT] Connection error: ${error.message}`);
        });
        this.client.on('close', () => {
            this.connected = false;
        });
        this.client.on('offline', () => {
            this.connected = false;
        });
        this.client.on('reconnect', () => {
            this.connected = false;
        });
    }

    _applyTlsOptions(options) {
        if (!tlsConfig || !tlsConfig.enabled) {
            return;
        }
        const maybeRead = (filePath) => {
            try {
                if (filePath) {
                    return fs.readFileSync(filePath);
                }
            } catch (err) {
                logger.log('error', `[MQTT] Failed to read TLS file '${filePath}': ${err.message}`);
            }
            return undefined;
        };

        options.ca = maybeRead(tlsConfig.caPath);
        options.key = maybeRead(tlsConfig.keyPath);
        options.cert = maybeRead(tlsConfig.certPath);
        if (typeof tlsConfig.rejectUnauthorized === 'boolean') {
            options.rejectUnauthorized = tlsConfig.rejectUnauthorized;
        }
    }

    _onConnect() {
        this.connected = true;
        this.lastError = null;
        const writeTopicPattern = `bacnetwrite/${gatewayId}/+/+/+/set`;
        this.client.subscribe(writeTopicPattern, (err) => {
            if (err) {
                logger.log('error', `[MQTT] Error subscribing to write topic pattern ${writeTopicPattern}: ${err}`);
            }
        });

        this.client.on('message', (topic, message) => this._onMessage(topic, message));
    }

    _onMessage(topic, message) {
        const topicParts = topic.split('/');
        if (topicParts.length === 6 && topicParts[0] === 'bacnetwrite' && topicParts[5] === 'set') {
            const receivedGatewayId = topicParts[1];
            const deviceIdFromTopic = topicParts[2];
            const objectKey = topicParts[3];
            const propertyIdFromTopicStr = topicParts[4];

            if (receivedGatewayId !== gatewayId) {
                logger.log('warn', `[MQTT Write] Received write command for wrong gatewayId. Expected ${gatewayId}, got ${receivedGatewayId}. Ignoring.`);
                return;
            }

            const objectIdParts = objectKey.split('_');
            if (objectIdParts.length !== 2) {
                logger.log('warn', `[MQTT Write] Malformed objectKey in topic ${topic}: ${objectKey}. Expected type_instance.`);
                return;
            }

            const objectType = parseInt(objectIdParts[0], 10);
            const objectInstance = parseInt(objectIdParts[1], 10);
            const propertyIdFromTopic = parseInt(propertyIdFromTopicStr, 10);

            if (isNaN(objectType) || isNaN(objectInstance) || isNaN(propertyIdFromTopic)) {
                logger.log('warn', `[MQTT Write] Invalid objectType, objectInstance, or propertyId in topic ${topic}. Parts: type=${objectType}, instance=${objectInstance}, propId=${propertyIdFromTopic}`);
                return;
            }

            let payload;
            try {
                payload = JSON.parse(message.toString());
            } catch (_e) {
                payload = { value: message.toString() };
            }

            if (payload.value === undefined) {
                logger.log('warn', `[MQTT Write] No 'value' field in JSON payload for topic ${topic}. Payload: ${message.toString()}`);
                return;
            }
            this.emit('bacnetWriteCommand', {
                deviceId: deviceIdFromTopic,
                objectKey,
                objectType,
                objectInstance,
                propertyId: propertyIdFromTopic,
                value: payload.value,
                priority: payload.priority,
                bacnetApplicationTag: payload.bacnetApplicationTag
            });
        }
    }

    _publish(topic, message, options = {}) {
        this.client.publish(topic, message, options, (err) => {
            if (err) {
                this.publishFailureCount += 1;
                this.lastError = err.message || String(err);
                logger.log('error', `[MQTT] Publish failed for ${topic}: ${this.lastError}`);
                return;
            }
            this.publishSuccessCount += 1;
            this.lastPublishedAt = Date.now();
        });
    }

    _getHaComponentType(objectKey) {
        const bacnetObjectType = objectKey.split('_')[0];
        if (bacnetObjectType === '0' || bacnetObjectType === '2' || bacnetObjectType === '13' || bacnetObjectType === '19' || bacnetObjectType === '139' || bacnetObjectType === '140' || bacnetObjectType === '141' || bacnetObjectType === '143') {
            return 'sensor';
        }
        if (bacnetObjectType === '3' || bacnetObjectType === '5' || bacnetObjectType === '21') {
            return 'binary_sensor';
        }
        logger.log('warn', `[MQTT] Unknown BACnet object type ${bacnetObjectType} for key ${objectKey}, defaulting to HA type 'sensor'.`);
        return 'sensor';
    }

    _publishTelemetryMap(telemetryMap) {
        for (const [objectKey, telemetry] of Object.entries(telemetryMap)) {
            const component = this._getHaComponentType(objectKey);
            const stateTopic = `homeassistant/${component}/${gatewayId}/${objectKey}/state`;
            const attributesTopic = `homeassistant/${component}/${gatewayId}/${objectKey}/attributes`;
            const canonicalTopic = `bacnet-gateway/${gatewayId}/telemetry/${telemetry.deviceId}/${objectKey}`;

            this._publish(stateTopic, JSON.stringify(telemetry.value), { retain: true });
            this._publish(attributesTopic, JSON.stringify({
                name: telemetry.name,
                deviceId: telemetry.deviceId,
                address: telemetry.address,
                acquiredAt: telemetry.acquiredAt,
                publishedAt: telemetry.publishedAt,
                freshnessMs: telemetry.freshnessMs,
                sourceStatus: telemetry.sourceStatus,
                pollDurationMs: telemetry.pollDurationMs,
                pollClass: telemetry.pollClass
            }), { retain: true });
            this._publish(canonicalTopic, JSON.stringify(telemetry), { retain: true });
        }
    }

    publishMessage(messageJson) {
        if (messageJson && typeof messageJson === 'object' && !Array.isArray(messageJson)) {
            const keys = Object.keys(messageJson);
            const looksLikeTelemetryMap = keys.length > 0 && keys.every((key) => {
                const value = messageJson[key];
                return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value');
            });

            if (looksLikeTelemetryMap) {
                this._publishTelemetryMap(messageJson);
                return;
            }

            if (typeof messageJson.deviceId !== 'undefined' && typeof messageJson.address !== 'undefined') {
                const topic = `bacnet-gateway/${gatewayId}/device_found/${messageJson.deviceId}`;
                this._publish(topic, JSON.stringify(messageJson), { retain: true });
                return;
            }
        }

        if (JSON.stringify(messageJson) === '{}') {
            logger.log('warn', '[MQTT] Received empty object to publish. Skipping.');
            return;
        }

        logger.log('warn', `[MQTT] Unknown message structure. Publishing to default/error topic: ${JSON.stringify(messageJson)}`);
        this._publish(`bacnet-gateway/${gatewayId}/unknown_data`, JSON.stringify(messageJson));
    }

    getStatus() {
        return {
            connected: this.connected,
            lastError: this.lastError,
            publishSuccessCount: this.publishSuccessCount,
            publishFailureCount: this.publishFailureCount,
            lastPublishedAt: this.lastPublishedAt
        };
    }
}

module.exports = { MqttClient };
