const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('config');
const { DeviceObjectId, DeviceObject, logger } = require('./common');

const devicesFolder = config.get('bacnet.configFolder');

class BacnetConfig extends EventEmitter {

    load() {
        fs.readdir(devicesFolder, (err, files) => {
            if (err) {
                logger.log('error', `Error while reading config folder: ${err}`);
            } else {
                logger.log('info', `Device configs found: ${files}`);
                files.forEach(file => {
                    // files with _ should be interpreted as deactivated and therefore are skipped
                    if (file.startsWith('_')) {
                        logger.log('info', `Skipping deactivated file ${file}`)
                    } else {
                        fs.readFile(path.join(devicesFolder, file), 'utf8', (err, contents) => {
                            if (err) {
                                logger.log('error', `Error while reading config file: ${err}`);
                            } else {
                                try {
                                    const deviceConfig = JSON.parse(contents);
                                    this.emit('configLoaded', deviceConfig);
                                } catch (parseErr) {
                                    logger.log('error', `Error while parsing config file '${file}': ${parseErr}`);
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    save(deviceConfig) {
        const filename = `device.${deviceConfig.device.deviceId}.json`;
        fs.writeFile(path.join(devicesFolder, filename), JSON.stringify(deviceConfig, null, 4), function (err) {
            if (err) {
                logger.log('error', `Error while writing config file: ${err}`);
            } else {
                logger.log('info', `Config file '${filename}' successfully saved.`);
            }
        });
    }

    delete(deviceId) {
        const filename = `device.${deviceId}.json`;
        const targetPath = path.join(devicesFolder, filename);
        return new Promise((resolve, reject) => {
            fs.unlink(targetPath, (err) => {
                if (err) {
                    logger.log('error', `Error while deleting config file '${targetPath}': ${err}`);
                    reject(err);
                } else {
                    logger.log('info', `Config file '${filename}' successfully deleted.`);
                    resolve();
                }
            });
        });
    }
}

module.exports = { BacnetConfig };
