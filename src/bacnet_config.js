const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('config');
const { DeviceObjectId, DeviceObject, logger } = require('./common');

const devicesFolder = config.get('bacnet.configFolder');

class BacnetConfig extends EventEmitter {
    _buildConfigPath(deviceId) {
        const safeDeviceId = String(deviceId);
        if (!/^[A-Za-z0-9_-]+$/.test(safeDeviceId)) {
            throw new Error(`Invalid deviceId for config path: ${safeDeviceId}`);
        }

        const filename = `device.${safeDeviceId}.json`;
        const baseDir = path.resolve(devicesFolder);
        const targetPath = path.resolve(baseDir, filename);
        const relativePath = path.relative(baseDir, targetPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            throw new Error(`Resolved config path escaped config folder: ${filename}`);
        }

        return { filename, targetPath };
    }

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
        let configPath;
        try {
            configPath = this._buildConfigPath(deviceConfig.device.deviceId);
        } catch (err) {
            logger.log('error', `Error while resolving config file path: ${err}`);
            return;
        }

        fs.writeFile(configPath.targetPath, JSON.stringify(deviceConfig, null, 4), function (err) {
            if (err) {
                logger.log('error', `Error while writing config file: ${err}`);
            } else {
                logger.log('info', `Config file '${configPath.filename}' successfully saved.`);
            }
        });
    }

    delete(deviceId) {
        let configPath;
        try {
            configPath = this._buildConfigPath(deviceId);
        } catch (err) {
            logger.log('error', `Error while resolving config file path: ${err}`);
            return Promise.reject(err);
        }

        return new Promise((resolve, reject) => {
            fs.unlink(configPath.targetPath, (err) => {
                if (err) {
                    logger.log('error', `Error while deleting config file '${configPath.targetPath}': ${err}`);
                    reject(err);
                } else {
                    logger.log('info', `Config file '${configPath.filename}' successfully deleted.`);
                    resolve();
                }
            });
        });
    }
}

module.exports = { BacnetConfig };
