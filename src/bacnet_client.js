const bacnet = require('bacstack');
const config = require('config');
const { scheduleJob } = require('node-schedule');
const { EventEmitter } = require('events');
const { BacnetConfig } = require('./bacnet_config');
const { DeviceObjectId, DeviceObject, logger } = require('./common');
const { RuntimeState } = require('./runtime_state');

class BacnetClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.requestOptions = this._loadRequestOptions();
        this.client = new bacnet({ apduTimeout: 10000 });
        this.deviceConfigs = new Map();
        this.deviceRuntime = new Map();
        this.schedules = new Map();
        this.queue = [];
        this.queuedDevices = new Set();
        this.activePolls = 0;

        const pollingConfig = config.has('polling') ? config.get('polling') : {};
        this.globalConcurrency = parseInt(pollingConfig.globalConcurrency || 2, 10);
        this.objectConcurrency = parseInt(pollingConfig.objectConcurrency || 4, 10);
        this.schedulerTickMs = parseInt(pollingConfig.schedulerTickMs || 1000, 10);
        this.defaultFreshnessMs = parseInt(pollingConfig.defaultFreshnessMs || 30000, 10);
        this.failureThreshold = parseInt(pollingConfig.failureThreshold || 3, 10);
        this.baseBackoffMs = parseInt(pollingConfig.baseBackoffMs || 5000, 10);
        this.maxBackoffMs = parseInt(pollingConfig.maxBackoffMs || 120000, 10);

        this.metrics = {
            totalPolls: 0,
            successfulPolls: 0,
            failedPolls: 0,
            totalObjectsRead: 0,
            totalObjectFailures: 0,
            totalPollDurationMs: 0,
            lastPollAt: null,
            queueHighWaterMark: 0
        };

        this.runtimeState = options.runtimeState || new RuntimeState();
        this.bacnetConfig = options.bacnetConfig || new BacnetConfig();

        this.client.on('iAm', (device) => {
            this.emit('deviceFound', device);
        });

        this.ready = this._init();
        this.schedulerHandle = setInterval(() => {
            this._schedulerLoop().catch((err) => {
                logger.log('error', `[Polling] Scheduler loop failed: ${err.message || err}`);
            });
        }, this.schedulerTickMs);
    }

    async _init() {
        if (this.runtimeState && typeof this.runtimeState.init === 'function') {
            await this.runtimeState.init();
        }
        this.bacnetConfig.on('configLoaded', (deviceConfig) => {
            this._registerDeviceConfig(deviceConfig).catch((err) => {
                logger.log('error', `[Polling] Failed to register config: ${err.message || err}`);
            });
        });
        this.bacnetConfig.load();
    }

    _loadRequestOptions() {
        const options = {};
        if (config.has('bacnet.maxSegments')) {
            const maxSegments = parseInt(config.get('bacnet.maxSegments'), 10);
            if (!Number.isNaN(maxSegments)) {
                options.maxSegments = maxSegments;
            }
        }
        if (config.has('bacnet.maxAdpu')) {
            const maxAdpu = parseInt(config.get('bacnet.maxAdpu'), 10);
            if (!Number.isNaN(maxAdpu)) {
                options.maxAdpu = maxAdpu;
            }
        }
        return options;
    }

    _buildRequestOptions(priority) {
        const options = { ...this.requestOptions };
        if (priority !== undefined) {
            options.priority = priority;
        }
        return options;
    }

    async _registerDeviceConfig(deviceConfig) {
        if (!deviceConfig || !deviceConfig.device || deviceConfig.device.deviceId === undefined) {
            logger.log('warn', '[BacnetClient] Loaded a device config without a valid deviceId.');
            return;
        }

        const deviceId = deviceConfig.device.deviceId.toString();
        this.deviceConfigs.set(deviceId, deviceConfig);
        const runtime = this._getOrCreateRuntime(deviceConfig.device, deviceConfig.polling);
        runtime.objects = Array.isArray(deviceConfig.objects) ? deviceConfig.objects : [];
        runtime.polling = this._normalizePolling(deviceConfig.polling);
        runtime.address = deviceConfig.device.address;

        await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
        this._configureSchedule(deviceId, runtime.polling);
    }

    _normalizePolling(polling = {}) {
        const normalized = { ...polling };
        normalized.class = polling.class || 'normal';
        normalized.intervalMs = this._resolveIntervalMs(polling);
        normalized.freshnessMs = parseInt(polling.freshnessMs || normalized.intervalMs * 2 || this.defaultFreshnessMs, 10);
        normalized.schedule = polling.schedule || null;
        normalized.jitterMs = parseInt(polling.jitterMs || 0, 10);
        return normalized;
    }

    _resolveIntervalMs(polling = {}) {
        if (polling.intervalMs) {
            return parseInt(polling.intervalMs, 10);
        }
        const classIntervals = config.has('polling.classIntervals')
            ? config.get('polling.classIntervals')
            : { fast: 5000, normal: 15000, slow: 60000 };
        return parseInt(classIntervals[polling.class || 'normal'] || classIntervals.normal || 15000, 10);
    }

    _getOrCreateRuntime(device, polling = {}) {
        const deviceId = device.deviceId.toString();
        if (!this.deviceRuntime.has(deviceId)) {
            this.deviceRuntime.set(deviceId, {
                deviceId,
                address: device.address,
                pollClass: polling.class || 'normal',
                schedule: polling.schedule || null,
                nextDueAt: Date.now(),
                nextEligiblePollAt: Date.now(),
                consecutiveFailures: 0,
                circuitState: 'closed',
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastDurationMs: null,
                lastError: null,
                cronDue: false,
                objects: [],
                polling: this._normalizePolling(polling)
            });
        }
        return this.deviceRuntime.get(deviceId);
    }

    _serializeRuntime(runtime) {
        return {
            deviceId: runtime.deviceId,
            address: runtime.address,
            pollClass: runtime.pollClass,
            schedule: runtime.schedule,
            circuitState: runtime.circuitState,
            consecutiveFailures: runtime.consecutiveFailures,
            lastError: runtime.lastError,
            lastAttemptAt: runtime.lastAttemptAt,
            lastSuccessAt: runtime.lastSuccessAt,
            lastDurationMs: runtime.lastDurationMs,
            nextEligiblePollAt: runtime.nextEligiblePollAt
        };
    }

    _configureSchedule(deviceId, polling) {
        const existing = this.schedules.get(deviceId);
        if (existing && existing.job) {
            existing.job.cancel();
        }
        this.schedules.delete(deviceId);

        if (polling.schedule) {
            const job = scheduleJob(polling.schedule, () => {
                const runtime = this.deviceRuntime.get(deviceId);
                if (runtime) {
                    runtime.cronDue = true;
                }
            });
            this.schedules.set(deviceId, { job });
            return;
        }

        const runtime = this.deviceRuntime.get(deviceId);
        if (runtime) {
            const jitter = polling.jitterMs > 0 ? Math.floor(Math.random() * polling.jitterMs) : 0;
            runtime.nextDueAt = Date.now() + jitter;
        }
    }

    async _schedulerLoop() {
        await this.ready;
        const now = Date.now();
        for (const [deviceId, runtime] of this.deviceRuntime.entries()) {
            if (!runtime.objects || runtime.objects.length === 0) {
                continue;
            }
            if (this.queuedDevices.has(deviceId)) {
                continue;
            }
            if (runtime.nextEligiblePollAt && runtime.nextEligiblePollAt > now) {
                continue;
            }
            if (runtime.circuitState === 'open' && runtime.nextEligiblePollAt > now) {
                continue;
            }

            const dueBySchedule = runtime.schedule ? runtime.cronDue === true : runtime.nextDueAt <= now;
            if (!dueBySchedule) {
                continue;
            }

            runtime.cronDue = false;
            if (!runtime.schedule) {
                runtime.nextDueAt = now + runtime.polling.intervalMs;
            }
            this.queue.push(deviceId);
            this.queuedDevices.add(deviceId);
            this.metrics.queueHighWaterMark = Math.max(this.metrics.queueHighWaterMark, this.queue.length);
        }

        await this._drainQueue();
    }

    async _drainQueue() {
        while (this.activePolls < this.globalConcurrency && this.queue.length > 0) {
            const deviceId = this.queue.shift();
            this.queuedDevices.delete(deviceId);
            this.activePolls += 1;
            this._pollDevice(deviceId)
                .catch((err) => {
                    logger.log('error', `[Polling] Device poll failed for ${deviceId}: ${err.message || err}`);
                })
                .finally(() => {
                    this.activePolls -= 1;
                    if (this.queue.length > 0) {
                        setImmediate(() => {
                            this._drainQueue().catch((err) => {
                                logger.log('error', `[Polling] Queue drain failed: ${err.message || err}`);
                            });
                        });
                    }
                });
        }
    }

    async _pollDevice(deviceId) {
        const deviceConfig = this.deviceConfigs.get(deviceId);
        const runtime = this.deviceRuntime.get(deviceId);
        if (!deviceConfig || !runtime) {
            return;
        }

        const startedAt = Date.now();
        runtime.lastAttemptAt = startedAt;
        runtime.nextEligiblePollAt = startedAt;
        await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));

        const reads = await this._runWithConcurrency(runtime.objects, this.objectConcurrency, async (deviceObject) => {
            const objectId = deviceObject.objectId;
            const result = await this._readObjectPresentValue(deviceConfig.device.address, objectId.type, objectId.instance);
            return { objectId, result };
        });

        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        this.metrics.totalPolls += 1;
        this.metrics.totalPollDurationMs += durationMs;
        this.metrics.lastPollAt = completedAt;

        const values = {};
        let successCount = 0;
        let failureCount = 0;
        let pollErrorClass = null;

        for (const entry of reads) {
            const objectKey = `${entry.objectId.type}_${entry.objectId.instance}`;
            if (entry.result.error || !entry.result.value || !entry.result.value.values || entry.result.value.values.length === 0) {
                failureCount += 1;
                this.metrics.totalObjectFailures += 1;
                if (entry.result.error && !pollErrorClass) {
                    pollErrorClass = entry.result.error.message || 'bacnet_read_error';
                }
                continue;
            }

            successCount += 1;
            this.metrics.totalObjectsRead += 1;
            const object = entry.result.value;
            const presentValue = this._findValueById(object.values[0].values, bacnet.enum.PropertyIds.PROP_PRESENT_VALUE);
            const objectName = this._findValueById(object.values[0].values, bacnet.enum.PropertyIds.PROP_OBJECT_NAME);
            const acquiredAt = completedAt;
            const freshnessMs = runtime.polling.freshnessMs;

            values[objectKey] = {
                value: presentValue,
                name: objectName,
                objectKey,
                objectType: entry.objectId.type,
                objectInstance: entry.objectId.instance,
                deviceId,
                address: deviceConfig.device.address,
                acquiredAt,
                publishedAt: completedAt,
                freshnessMs,
                sourceStatus: 'fresh',
                pollDurationMs: durationMs,
                pollClass: runtime.polling.class
            };

            await this.runtimeState.saveObjectTelemetry(deviceId, objectKey, values[objectKey]);
        }

        if (successCount > 0) {
            runtime.consecutiveFailures = 0;
            runtime.circuitState = 'closed';
            runtime.lastSuccessAt = completedAt;
            runtime.lastError = null;
            runtime.lastDurationMs = durationMs;
            runtime.nextEligiblePollAt = completedAt;
            this.metrics.successfulPolls += 1;
            await this.runtimeState.recordPollHistory({
                deviceId,
                objectCount: runtime.objects.length,
                successCount,
                failureCount,
                durationMs,
                status: failureCount > 0 ? 'partial' : 'success',
                errorClass: pollErrorClass,
                createdAt: completedAt
            });
            await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
            this.emit('values', deviceConfig.device, values);
            return;
        }

        runtime.consecutiveFailures += 1;
        runtime.circuitState = runtime.consecutiveFailures >= this.failureThreshold ? 'open' : 'closed';
        runtime.lastError = pollErrorClass || 'poll_failed';
        runtime.lastDurationMs = durationMs;
        runtime.nextEligiblePollAt = completedAt + this._calculateBackoffMs(runtime.consecutiveFailures);
        this.metrics.failedPolls += 1;
        await this.runtimeState.recordPollHistory({
            deviceId,
            objectCount: runtime.objects.length,
            successCount,
            failureCount,
            durationMs,
            status: 'failed',
            errorClass: runtime.lastError,
            createdAt: completedAt
        });
        await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
    }

    _calculateBackoffMs(consecutiveFailures) {
        const factor = Math.max(0, consecutiveFailures - 1);
        return Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, factor));
    }

    async _runWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let index = 0;
        const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
            while (index < items.length) {
                const current = index;
                index += 1;
                try {
                    results[current] = await worker(items[current], current);
                } catch (err) {
                    results[current] = {
                        objectId: items[current].objectId,
                        result: { error: err, value: null }
                    };
                }
            }
        });
        await Promise.all(runners);
        return results;
    }

    _readObjectList(deviceAddress, deviceId, callback) {
        const requestArray = [{
            objectId: { type: bacnet.enum.ObjectTypes.OBJECT_DEVICE, instance: deviceId },
            properties: [
                { id: bacnet.enum.PropertyIds.PROP_OBJECT_LIST }
            ]
        }];
        this.client.readPropertyMultiple(deviceAddress, requestArray, this._buildRequestOptions(), callback);
    }

    _readObject(deviceAddress, type, instance, properties) {
        return new Promise((resolve) => {
            const requestArray = [{
                objectId: { type: type, instance: instance },
                properties: properties
            }];
            this.client.readPropertyMultiple(deviceAddress, requestArray, this._buildRequestOptions(), (error, value) => {
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
            { id: bacnet.enum.PropertyIds.PROP_OBJECT_NAME }
        ]);
    }

    _findValueById(properties, id) {
        const property = properties.find(function(element) {
            return element.id === id;
        });
        if (property && property.value && property.value.length > 0) {
            return property.value[0].value;
        }
        return null;
    }

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

                objectArray.forEach((object) => {
                    promises.push(this._readObjectFull(device.address, object.value.type, object.value.instance));
                });

                Promise.all(promises).then((resolved) => {
                    const successfulResults = resolved.filter((element) => !element.error);
                    const deviceObjects = successfulResults.map((element) => this._mapToDeviceObject(element.value));
                    this.emit('deviceObjects', device, deviceObjects);
                    resolve(deviceObjects);
                }).catch((error) => {
                    logger.log('error', `Error whilte fetching objects: ${error}`);
                    reject(error);
                });
            });
        });
    }

    startPolling(device, objects, pollingOrSchedule) {
        const pollSettings = typeof pollingOrSchedule === 'string'
            ? { schedule: pollingOrSchedule }
            : (pollingOrSchedule || {});
        const deviceConfig = {
            device,
            objects,
            polling: pollSettings
        };
        return this._registerDeviceConfig(deviceConfig);
    }

    saveConfig(deviceConfig) {
        this.bacnetConfig.save(deviceConfig);
        return this._registerDeviceConfig(deviceConfig);
    }

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
                    bacnetType = Number.isInteger(valueToWrite)
                        ? bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_SIGNED_INT
                        : bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_REAL;
                } else if (typeof valueToWrite === 'boolean') {
                    bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_BOOLEAN;
                    bacnetValue = valueToWrite ? 1 : 0;
                } else if (typeof valueToWrite === 'string') {
                    const numVal = parseFloat(valueToWrite);
                    if (!isNaN(numVal)) {
                        bacnetType = Number.isInteger(numVal)
                            ? bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_SIGNED_INT
                            : bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_REAL;
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
            const options = this._buildRequestOptions(priority);

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

    async listRuntimeStates() {
        return this.runtimeState.listDeviceStates();
    }

    getStatus() {
        const avgPollDurationMs = this.metrics.totalPolls > 0
            ? this.metrics.totalPollDurationMs / this.metrics.totalPolls
            : 0;
        return {
            configuredDevices: this.deviceConfigs.size,
            activePolls: this.activePolls,
            queuedPolls: this.queue.length,
            queueHighWaterMark: this.metrics.queueHighWaterMark,
            totalPolls: this.metrics.totalPolls,
            successfulPolls: this.metrics.successfulPolls,
            failedPolls: this.metrics.failedPolls,
            totalObjectsRead: this.metrics.totalObjectsRead,
            totalObjectFailures: this.metrics.totalObjectFailures,
            avgPollDurationMs,
            lastPollAt: this.metrics.lastPollAt
        };
    }
}

module.exports = { BacnetClient };
