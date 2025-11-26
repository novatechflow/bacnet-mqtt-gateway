const mqtt = require('mqtt');
const config = require('config');
const fs = require('fs');
const EventEmitter = require('events');
const {logger} = require('./common');
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

        const options = {
            host: host,
            port: port,
            protocol: tlsConfig.enabled ? 'mqtts' : 'mqtt', 
            username: username, 
            password: password, 
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
        // New topic: bacnetwrite/<gatewayId>/<deviceId>/<objectType>_<objectInstance>/<propertyId>/set
        const writeTopicPattern = `bacnetwrite/${gatewayId}/+/+/+/set`; 
        this.client.subscribe(writeTopicPattern, (err) => {
            if (err) {
                logger.log('error', `[MQTT] Error subscribing to write topic pattern ${writeTopicPattern}: ${err}`);
            } else {
            }
        });

        this.client.on('message', (topic, message) => this._onMessage(topic, message));

        this.client.on('error', function (err) {
            logger.log('error', err);
        });
    };

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
            } catch (e) {
                // If not a JSON object, assume the raw message is the value, and priority is undefined.
                // This maintains compatibility with sending just a simple value.
                payload = { value: message.toString() };
            }

            const valueToWrite = payload.value;
            const priority = payload.priority; 
            const bacnetApplicationTag = payload.bacnetApplicationTag;

            if (valueToWrite === undefined) {
                logger.log('warn', `[MQTT Write] No 'value' field in JSON payload for topic ${topic}. Payload: ${message.toString()}`);
                return;
            }
            this.emit('bacnetWriteCommand', {
                deviceId: deviceIdFromTopic, 
                objectKey: objectKey, 
                objectType: objectType,
                objectInstance: objectInstance,
                propertyId: propertyIdFromTopic, 
                value: valueToWrite,
                priority: priority,
                bacnetApplicationTag: bacnetApplicationTag
            });
        }
    }

    publishMessage(messageJson) {
        const keys = Object.keys(messageJson);
        if (keys.length > 0 && messageJson[keys[0]] && typeof messageJson[keys[0]].value !== 'undefined') {
            keys.forEach(key => { // key is like "2_202"
                const bacnetObjectType = key.split('_')[0]; // e.g., "2"
                let haComponentType = 'sensor'; 

                // Using string comparison for object types as in the user's snippet
                if (bacnetObjectType === '0' || bacnetObjectType === '2' || bacnetObjectType === '139' || bacnetObjectType === '140' || bacnetObjectType === '141' || bacnetObjectType === '143') {
                    haComponentType = 'sensor';
                } else if (bacnetObjectType === '3' || bacnetObjectType === '5' || bacnetObjectType === '21') {
                    haComponentType = 'binary_sensor';
                } else if (bacnetObjectType === '13' || bacnetObjectType === '19') { 
                    haComponentType = 'sensor'; 
                } else {
                    haComponentType = 'sensor';
                    logger.log('warn', `[MQTT] Unknown BACnet object type ${bacnetObjectType} for key ${key}, defaulting to HA type 'sensor'.`);
                }

                const topic = `homeassistant/${haComponentType}/${gatewayId}/${key}/state`;
                const message = JSON.stringify(messageJson[key].value);

                this.client.publish(topic, message, { retain: true }); 
            });
        } else if (messageJson && typeof messageJson.deviceId !== 'undefined' && typeof messageJson.address !== 'undefined') {
            // Example topic: bacnet-gateway/YOUR_GATEWAY_ID/device_found/DEVICE_ID
            const topic = `bacnet-gateway/${gatewayId}/device_found/${messageJson.deviceId}`;
            const message = JSON.stringify(messageJson);
            this.client.publish(topic, message, { retain: true });
        } else {
            if (keys.length === 0 && JSON.stringify(messageJson) === '{}') {
                logger.log('warn', '[MQTT] Received empty object to publish. Skipping.');
                return; 
            }
            logger.log('warn', `[MQTT] Unknown message structure. Publishing to default/error topic: ${JSON.stringify(messageJson)}`);
            const topic = `bacnet-gateway/${gatewayId}/unknown_data`;
            const message = JSON.stringify(messageJson);
            this.client.publish(topic, message);
        }
    }

    getStatus() {
        return {
            connected: this.connected,
            lastError: this.lastError
        };
    }
}

module.exports = {MqttClient};
