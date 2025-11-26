require('dotenv').config(); 

const { BacnetClient } = require('./bacnet_client');
const { Server } = require('./server');
const { logger } = require('./common');
const { MqttClient } = require('./mqtt_client');
const { AuthService } = require('./auth_service');
const config = require('config');
const httpServerEnabled = config.get('httpServer.enabled');

// init MQTT and BACnet clients
const mqttClient = new MqttClient();
const bacnetClient = new BacnetClient();
const authService = new AuthService();

bacnetClient.on('deviceFound', (device) => {
    mqttClient.publishMessage(device);
});

bacnetClient.on('values', (device, values) => {
    mqttClient.publishMessage(values);
});

mqttClient.on('bacnetWriteCommand', (command) => {
    const { deviceId, objectKey, objectType, objectInstance, propertyId, value, priority, bacnetApplicationTag } = command;
    const targetDeviceConfig = bacnetClient.deviceConfigs.get(deviceId.toString());

    if (targetDeviceConfig && targetDeviceConfig.device && targetDeviceConfig.device.address) {
        const targetDeviceAddress = targetDeviceConfig.device.address;
        const bacnetObjectId = { type: objectType, instance: objectInstance };
        // Construct status topic using the new structure elements
        // Example: bacnetwrite_status/<gatewayId>/<deviceId>/<objectKey>/<propertyId>
        const gatewayIdForTopic = config.get('mqtt.gatewayId');
        const writeStatusTopic = `bacnetwrite_status/${gatewayIdForTopic}/${deviceId}/${objectKey}/${propertyId}`;

        bacnetClient.writeProperty(targetDeviceAddress, bacnetObjectId, propertyId, value, priority, bacnetApplicationTag)
            .then(response => {
                const successMsg = `[App] BACnet write successful for DeviceID: ${deviceId}, ObjectKey: ${objectKey}, Property: ${propertyId}: ${JSON.stringify(response)} (Priority: ${priority}, AppTag: ${bacnetApplicationTag})`;
           
                mqttClient.publishMessage({
                    [writeStatusTopic]: { status: 'success', detail: successMsg, writtenValue: value }
                });
            })
            .catch(error => {
                const errorMsg = `[App] BACnet write failed for DeviceID: ${deviceId}, ObjectKey: ${objectKey}, Property: ${propertyId}: ${error.message || error}`;
                logger.log('error', errorMsg);
                mqttClient.publishMessage({
                    [writeStatusTopic]: { status: 'error', detail: errorMsg, attemptedValue: value }
                });
            });
    } else {
        logger.log('warn', `[App] Could not find a configured device for DeviceID ${deviceId} (from topic) to perform write operation for objectKey ${objectKey}.`);
        const gatewayIdForTopic = config.get('mqtt.gatewayId');
        const statusTopic = `bacnetwrite_status/${gatewayIdForTopic}/${deviceId || 'unknown_device'}/${objectKey}/${propertyId || 'unknown_property'}`;
         mqttClient.publishMessage({
            [statusTopic]: { status: 'error', detail: `Device configuration not found for DeviceID ${deviceId}` }
        });
    }
});

async function init() {
    try {
        const seededPassword = await authService.init();
        if (seededPassword) {
            logger.log('info', `[Auth] Initial admin user 'admin' created with password: ${seededPassword}`);
        }
        if (httpServerEnabled) {
            new Server(bacnetClient, mqttClient, authService);
        }
    } catch (err) {
        logger.log('error', `[App] Failed to initialize auth service: ${err}`);
        process.exit(1);
    }
}
init();
