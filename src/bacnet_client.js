const bacnet = require('bacstack');
const { scheduleJob } = require('node-schedule');
const { EventEmitter } = require('events');
const { BacnetConfig } = require('./bacnet_config');
const { DeviceObjectId, DeviceObject, logger } = require('./common');

class BacnetClient extends EventEmitter {

    constructor() {
        super();
        this.client = new bacnet({ apduTimeout: 10000 });
        this.deviceConfigs = new Map();

        this.client.on('iAm', (device) => {
            this.emit('deviceFound', device);
        });

        this.bacnetConfig = new BacnetConfig();
        this.bacnetConfig.on('configLoaded', (deviceConfig) => {
            if (deviceConfig && deviceConfig.device && deviceConfig.device.deviceId !== undefined) {
                this.deviceConfigs.set(deviceConfig.device.deviceId.toString(), deviceConfig);
            } else {
                logger.log('warn', '[BacnetClient] Loaded a device config without a valid deviceId.');
                return;
            }
            this.startPolling(deviceConfig.device, deviceConfig.objects, deviceConfig.polling && deviceConfig.polling.schedule);
        })
        this.bacnetConfig.load();
    }

    _readObjectList(deviceAddress, deviceId, callback) {
        const requestArray = [{
            objectId: { type: bacnet.enum.ObjectTypes.OBJECT_DEVICE, instance: deviceId },
            properties: [
                { id: bacnet.enum.PropertyIds.PROP_OBJECT_LIST }
            ]
        }];
        this.client.readPropertyMultiple(deviceAddress, requestArray, callback);
    }

    _readObject(deviceAddress, type, instance, properties) {
        return new Promise((resolve, reject) => {
            const requestArray = [{
                objectId: { type: type, instance: instance },
                properties: properties
            }];
            this.client.readPropertyMultiple(deviceAddress, requestArray, (error, value) => {
                resolve({
                    error: error,
                    value: value
                });
            });
        });
    }

    _readObjectFull(deviceAddress, type, instance) {
        return this._readObject(deviceAddress, type, instance, [
            { id: bacnet.enum.PropertyIds.PROP_OBJECT_IDENTIFIER },
            { id: bacnet.enum.PropertyIds.PROP_OBJECT_NAME },
            { id: bacnet.enum.PropertyIds.PROP_OBJECT_TYPE },
            { id: bacnet.enum.PropertyIds.PROP_DESCRIPTION },
            { id: bacnet.enum.PropertyIds.PROP_UNITS },
            { id: bacnet.enum.PropertyIds.PROP_PRESENT_VALUE }
        ]);
    }

    _readObjectPresentValue(deviceAddress, type, instance) {
        return this._readObject(deviceAddress, type, instance, [
            { id: bacnet.enum.PropertyIds.PROP_PRESENT_VALUE },
            { id: bacnet.enum.PropertyIds.PROP_OBJECT_NAME}
        ]);
    }

    _findValueById(properties, id) {
        const property = properties.find(function (element) {
            return element.id === id;
        });
        if (property && property.value && property.value.length > 0) {
            return property.value[0].value;
        } else {
            return null;
        }
    };

    _mapToDeviceObject(object) {
        if (!object || !object.values) {
            return null;
        }

        const objectInfo = object.values[0].objectId;
        const deviceObjectId = new DeviceObjectId(objectInfo.type, objectInfo.instance);

        const objectProperties = object.values[0].values;
        const name = this._findValueById(objectProperties, bacnet.enum.PropertyIds.PROP_OBJECT_NAME);
        const description = this._findValueById(objectProperties, bacnet.enum.PropertyIds.PROP_DESCRIPTION);
        const type = this._findValueById(objectProperties, bacnet.enum.PropertyIds.PROP_OBJECT_TYPE);
        const units = this._findValueById(objectProperties, bacnet.enum.PropertyIds.PROP_UNITS);
        const presentValue = this._findValueById(objectProperties, bacnet.enum.PropertyIds.PROP_PRESENT_VALUE);

        return new DeviceObject(deviceObjectId, name, description, type, units, presentValue);
    }

    scanForDevices() {
        this.client.whoIs();
    }

    scanDevice(device) {
        return new Promise((resolve, reject) => {
            this._readObjectList(device.address, device.deviceId, (err, result) => {
                if (err) {
                    logger.log('error', `Error whilte fetching objects: ${err}`);
                    reject(err);
                    return;
                }
                const objectArray = result.values[0].values[0].value;
                const promises = [];

                objectArray.forEach(object => {
                    promises.push(this._readObjectFull(device.address, object.value.type, object.value.instance));
                });

                Promise.all(promises).then((result) => {
                    const successfulResults = result.filter(element => !element.error);
                    const deviceObjects = successfulResults.map(element => this._mapToDeviceObject(element.value));
                    this.emit('deviceObjects', device, deviceObjects);
                    resolve(deviceObjects);
                }).catch((error) => {
                    logger.log('error', `Error whilte fetching objects: ${error}`);
                    reject(error);
                });
            });
        });
    }

    startPolling(device, objects, scheduleExpression) {
        if (!device || !device.address) {
            logger.log('warn', `[Polling] Missing device or address, skipping schedule for config: ${JSON.stringify(device)}`);
            return;
        }
        if (!Array.isArray(objects) || objects.length === 0) {
            logger.log('warn', `[Polling] No objects configured for device ${device.deviceId}, skipping schedule.`);
            return;
        }
        if (!scheduleExpression) {
            logger.log('warn', `[Polling] No schedule expression provided for device ${device.deviceId}, skipping schedule.`);
            return;
        }

        try {
            scheduleJob(scheduleExpression, () => {
            const promises = [];
            objects.forEach(deviceObject => {
                const objectIdToRead = { type: deviceObject.objectId.type, instance: deviceObject.objectId.instance };
                promises.push(
                    this._readObjectPresentValue(device.address, deviceObject.objectId.type, deviceObject.objectId.instance)
                        .then(res => {
                            if (res.error) {
                                logger.log('warn', `[Polling] Error reading ${JSON.stringify(objectIdToRead)}: ${JSON.stringify(res.error)}`);
                            }
                            return res;
                        })
                );
            });
            Promise.all(promises).then((result) => {
                const values = {};
                const successfulResults = result.filter(element => {
                    if (element.error) {
                        return false;
                    }
                    if (!element.value || !element.value.values || element.value.values.length === 0) {
                        logger.log('warn', `[Polling] Filtering out result with no values: ${JSON.stringify(element.value)}`);
                        return false;
                    }
                    return true;
                }).map(element => element.value);

                successfulResults.forEach(object => {
                    if (!object || !object.values || object.values.length === 0 || !object.values[0].values) {
                        logger.log('warn', `[Polling] Skipping malformed successful result: ${JSON.stringify(object)}`);
                        return;
                    }
                    const objectId = object.values[0].objectId.type + '_' + object.values[0].objectId.instance;
                    const presentValue = this._findValueById(object.values[0].values, bacnet.enum.PropertyIds.PROP_PRESENT_VALUE);
                    const objectName = this._findValueById(object.values[0].values, bacnet.enum.PropertyIds.PROP_OBJECT_NAME);

                    values[objectId] = {};
	                  values[objectId].value = presentValue;
	                  values[objectId].name = objectName;
                });
                this.emit('values', device, values);
            }).catch(function (error) {
                logger.log('error', `Error while fetching values: ${error}`);
            });
        });
        } catch (err) {
            logger.log('error', `[Polling] Failed to schedule job for device ${device.deviceId}: ${err}`);
        }
    }

    saveConfig(config) {
        this.bacnetConfig.save(config);
    }

    /**
     * Writes a property to a BACnet device.
     * @param {string} deviceAddress - The IP address of the BACnet device.
     * @param {object} objectId - The BACnet objectId {type, instance}.
     * @param {number} propertyId - The BACnet propertyId (e.g., bacnet.enum.PropertyIds.PROP_PRESENT_VALUE).
     * @param {any} valueToWrite - The value to write.
     * @param {number} [priority] - Optional write priority (1-16).
     * @param {number} [bacnetApplicationTag] - Optional BACnet Application Tag for the value.
     * @returns {Promise<object>} A promise that resolves with the write confirmation or rejects with an error.
     */
    writeProperty(deviceAddress, objectId, propertyId, valueToWrite, priority, bacnetApplicationTag) {
        return new Promise((resolve, reject) => {
            let bacnetValue = valueToWrite; 
            let bacnetType;

            if (bacnetApplicationTag !== undefined && typeof bacnetApplicationTag === 'number') {
                bacnetType = bacnetApplicationTag;
                if (bacnetType === bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_BOOLEAN) {
                    bacnetValue = valueToWrite ? 1 : 0;
                }
            } else {
                if (typeof valueToWrite === 'number') {
                    if (Number.isInteger(valueToWrite)) {
                        bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_SIGNED_INT;
                    } else {
                        bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_REAL;
                    }
                } else if (typeof valueToWrite === 'boolean') {
                    bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_BOOLEAN;
                    bacnetValue = valueToWrite ? 1 : 0;
                } else if (typeof valueToWrite === 'string') {
                    const numVal = parseFloat(valueToWrite);
                    if (!isNaN(numVal)) { 
                        if (Number.isInteger(numVal)) {
                            bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_SIGNED_INT;
                        } else {
                            bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_REAL;
                        }
                        bacnetValue = numVal;
                    } else { 
                        bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_CHARACTER_STRING;
                    }
                } else {
                    reject(new Error(`Unsupported value type for BACnet write: ${typeof valueToWrite} (and no BACnetApplicationTag provided)`));
                    return;
                }
            }

            const values = [{ type: bacnetType, value: bacnetValue }];
            const options = priority ? { priority: priority } : undefined;

            this.client.writeProperty(deviceAddress, objectId, propertyId, values, options, (err, val) => {
                if (err) {
                    logger.log('error', `[BACnet Write] Error writing property: ${err}`);
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }
}

module.exports = { BacnetClient };
