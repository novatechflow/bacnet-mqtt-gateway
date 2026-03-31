# BACnet MQTT Gateway

BACnet MQTT Gateway connects BACnet devices to MQTT and is designed to survive production conditions, not just lab demos. It is written in Node.js and now includes bounded polling, SQLite-backed runtime state, explicit freshness metadata, and operational metrics for larger deployments.

For BACnet connection the [Node BACstack](https://github.com/fh1ch/node-bacstack) is used.

Pull prebuilt image:

```bash
docker pull ghcr.io/2pk03/bacnet-mqtt-gateway:latest
```

Quick start with Docker Compose (gateway + Mosquitto):

```bash
cp .env.example .env   # adjust credentials and gateway ID
docker compose up -d --build
```

This uses `docker-compose.yml` and `mosquitto.conf` in the repo, builds a local image tag (`bacnet-mqtt-gateway:local`), and mounts `./devices` and `./config` into the container.
The auth database lives in `./data` (mounted), so credentials persist across restarts.

## Functionalities

* Discover BACnet devices in network (WhoIs)
* Read object list from BACnet device (Read Property)
* Read present value from defined list of BACnet objects and send it to an MQTT broker
* Bounded polling scheduler with queueing, device classes, backoff, and circuit breaking
* SQLite runtime state for device health, last successful polls, and persisted telemetry metadata
* Write to BACnet object properties via MQTT or Web UI
    * Configurable Property ID, Write Priority, and BACnet Application Tag for writes.
    * MQTT feedback for write success/failure.
* REST and web interface for configuration and interaction
    * Web UI includes a "Stop Scan" button for device discovery.
* API documentation via Swagger UI.
* Production health and Prometheus metrics for queue depth, stale state, and device health

## Getting started

1. Clone repo and install npm dependencies:

    ```shell
    git clone https://github.com/2pk03/bacnet-mqtt-gateway.git
    cd bacnet-mqtt-gateway
    npm install
    ```

2. Configure gateway:

    Configuration is primarily managed via environment variables, typically loaded from a `.env` file in the project root. Create a `.env` file by copying `.env.example` (if it exists) or creating a new one.

    **Key Environment Variables (for `.env` file):**
    ```dotenv
    # MQTT Broker Configuration
    MQTT_HOST=your_mqtt_broker_host
    MQTT_PORT=1883 # Or your MQTT broker port
    MQTT_USERNAME=your_mqtt_username
    MQTT_PASSWORD=your_mqtt_password
    MQTT_GATEWAY_ID=my_bacnet_gateway_1 # Unique ID for this gateway instance

    # HTTP Server Configuration
    HTTP_PORT=8082 # Port for the web UI and REST API

    # Logging Configuration
    LOG_LEVEL=info # e.g., debug, info, warn, error

    # BACnet Request Options
    # Set BACNET_MAX_SEGMENTS=0 to disable segmentation if the target device doesn't support it.
    BACNET_MAX_SEGMENTS=112
    BACNET_MAX_ADPU=5

    # Polling / Runtime State
    POLLING_GLOBAL_CONCURRENCY=2
    POLLING_OBJECT_CONCURRENCY=4
    POLLING_DEFAULT_FRESHNESS_MS=30000
    POLLING_FAILURE_THRESHOLD=3
    POLLING_BASE_BACKOFF_MS=5000
    POLLING_MAX_BACKOFF_MS=120000
    RUNTIME_DB_PATH=./data/runtime.db

    # Optional MQTT TLS
    MQTT_TLS_ENABLED=false
    MQTT_TLS_CA_PATH=/path/to/ca.crt
    MQTT_TLS_CERT_PATH=/path/to/client.crt
    MQTT_TLS_KEY_PATH=/path/to/client.key
    MQTT_TLS_REJECT_UNAUTHORIZED=true

    # Auth / Users
    AUTH_DB_PATH=./data/auth.db
    AUTH_JWT_SECRET=super_secret_jwt_key
    AUTH_TOKEN_EXPIRES_IN=1h
    ```

    Default fallback values are present in `config/default.json`. The mapping between environment variables and the configuration structure is defined in `config/custom-environment-variables.json`.
    The original MQTT configuration using certificate paths in `config/default.json` has been replaced by username/password authentication via environment variables.
TLS is optional: set `MQTT_TLS_ENABLED=true` and point to CA/client cert/key paths to connect to secure brokers.

### Auth

On first startup, the gateway seeds an `admin` user with a **random password** and logs it once. Change it immediately by creating a new admin and deleting the default if desired.

Auth endpoints:
- `POST /auth/login` with `{ "username": "...", "password": "..." }` → returns JWT + refresh token.
- `POST /auth/register` (admin token required) with `{ "username": "...", "password": "...", "role": "admin|viewer" }`.
- `POST /auth/refresh` with `{ "refreshToken": "..." }` to rotate refresh tokens and get a new JWT.

Use the JWT in `Authorization: Bearer <token>` for all `/api/*` routes.
Health/metrics endpoints (`/health`, `/metrics`) remain unauthenticated.

Resetting the seeded admin password (if forgotten): stop the stack and delete the auth DB, or delete only the admin row to trigger reseed on next start:
```bash
docker-compose down
sqlite3 data/auth.db "DELETE FROM users WHERE username='admin';"
docker-compose up -d --build
```
The gateway will log a fresh random admin password on startup.

## Changelog

See `CHANGELOG.md` for recent changes and release highlights.

3. Start the gateway and open admin interface

    ```shell
    npm start
    ```
    Once started, the admin interface is typically available at `http://localhost:PORT/admin/` (e.g., `http://localhost:8082/admin/`).
    API documentation is available at `http://localhost:PORT/api-docs/`.

## Device polling configuration

The gateway can poll BACnet object present values and send the values via MQTT into the cloud. To configure polling for a BACnet device you can put a .json file into the devices folder.

```json
{
    "device": {
        "deviceId": 114,
        "address": "192.168.178.55"
    },
    "polling": {
        "class": "fast",
        "intervalMs": 5000,
        "freshnessMs": 15000
    },
    "objects": [{
        "objectId": {
            "type": 2,
            "instance": 202
        }
    }, {
        "objectId": {
            "type": 2,
            "instance": 203
        }
    }]
}
```

You need to define the device id, IP address, either a polling class or explicit interval/schedule, and the objects to poll.

Recommended production approach:

* `fast` for occupancy, temperatures, and business-critical signals
* `normal` for standard equipment state
* `slow` for setpoints and low-churn points

The gateway now queues device polls, bounds concurrent BACnet work, applies exponential backoff on repeated failure, and opens per-device circuit breakers when a controller becomes unhealthy.

When the gateway is started it automatically reads the list of files from the directory and starts the polling for all devices.
 
## REST API

To execute commands the gateway offers a REST API under `http://localhost:8082/api/bacnet`.

The following endpoints are supported:

* `PUT /api/bacnet`: Scan for devices (WhoIs)
    
    Scans for BACnet devices in the network (5s) and returns the answers. Body is empty.
    
    Example:
    ```
    PUT http://localhost:8082/api/bacnet/scan
    ```  
    (Body is empty)
    
* `PUT /api/bacnet/{deviceId}/objects`: Scan device for objects

    Scans a specific device for objects and returns the list of found objects.
    The request body should contain the `deviceId` and `address` of the target device.
    
    Example:
    ```
    PUT http://localhost:8082/api/bacnet/114/objects 
    # Request Body:
    {
        "deviceId":"114", 
        "address":"192.168.1.101"
    }
    ```
    
* `PUT /api/bacnet/{deviceId}/config`: Configure polling for a device

    Configures and starts polling for a specific device. The request body is the device configuration JSON (same structure as files in the `devices/` folder).
    
    Example:
    ```
    PUT http://localhost:8082/api/bacnet/114/config
    # Request Body: (see "Device polling configuration" section for structure)
    { ... device config ... }
    ```

* `PUT /api/bacnet/write`: Write to a BACnet object property

    Writes a value to a specified property of a BACnet object.
    Request Body:
    ```json
    {
      "deviceId": "114", // Configured deviceId for the target device
      "objectType": 1,     // BACnet Object Type (e.g., 1 for Analog Output)
      "objectInstance": 0, // BACnet Object Instance
      "propertyId": 85,    // BACnet Property ID (e.g., 85 for Present_Value)
      "value": 50.0,       // Value to write
      "priority": 8,       // Optional: Write priority (1-16)
      "bacnetApplicationTag": 4 // Optional: BACnet Application Tag (e.g., 4 for REAL)
    }
    ```

* `GET /health`: Health check including MQTT status, queue depth, stale object counts, and open circuit counts.
* `GET /metrics`: Prometheus-format metrics for MQTT connectivity, queue depth, poll totals, stale objects, and runtime device health.
* `GET /api/bacnet/runtime`: Persisted runtime device state from SQLite.

For a complete and interactive API specification, please refer to the Swagger UI documentation available at `/api-docs` when the gateway is running.

## MQTT Interface

### Reading Data (Polling)

Polled BACnet object values are published to multiple MQTT topic families:

* Home Assistant state: `homeassistant/<component_type>/<gateway_id>/<objectType>_<objectInstance>/state`
* Home Assistant attributes: `homeassistant/<component_type>/<gateway_id>/<objectType>_<objectInstance>/attributes`
* Canonical gateway telemetry: `bacnet-gateway/<gateway_id>/telemetry/<device_id>/<objectType>_<objectInstance>`

Example state topic: `homeassistant/sensor/my_bacnet_gateway_1/2_202/state`

Example canonical topic: `bacnet-gateway/my_bacnet_gateway_1/telemetry/114/2_202`

The canonical telemetry payload includes `value`, `name`, `deviceId`, `address`, `acquiredAt`, `publishedAt`, `freshnessMs`, `sourceStatus`, `pollDurationMs`, and `pollClass`.

Home Assistant discovery example (sensor):
```yaml
mqtt:
  sensor:
    - name: "Room Temp"
      state_topic: "homeassistant/sensor/my_bacnet_gateway_1/2_202/state"
      unit_of_measurement: "°C"
```

### Writing Data (Commands)

To write to a BACnet object, publish a message to the following MQTT topic:
`bacnetwrite/<gateway_id>/<device_id>/<objectType>_<objectInstance>/<property_id>/set`

*   `<gateway_id>`: The `MQTT_GATEWAY_ID` configured in your `.env` file.
*   `<device_id>`: The `deviceId` of the target BACnet device as defined in its configuration file in the `devices/` folder (e.g., "114").
*   `<objectType>_<objectInstance>`: The BACnet object type and instance (e.g., "1_0" for Analog Output 0).
*   `<property_id>`: The numeric BACnet Property ID to write to (e.g., "85" for Present\_Value).

**MQTT Payload for Writes:**
A JSON string with a `value` field and optional `priority` and `bacnetApplicationTag` fields:
```json
{
  "value": 25.5,
  "priority": 8,
  "bacnetApplicationTag": 4 
}
```
*   `value`: The value to write.
*   `priority` (optional): BACnet write priority (1-16).
*   `bacnetApplicationTag` (optional): Explicit BACnet Application Tag (e.g., 1 for BOOLEAN, 4 for REAL, 7 for CHARACTER_STRING). If not provided, the gateway attempts basic type inference.

**MQTT Write Status Feedback:**
After a write attempt, a status message is published to:
`bacnetwrite_status/<gateway_id>/<device_id>/<objectType>_<objectInstance>/<property_id>`
Payload: `{"status": "success/error", "detail": "...", ...}`

Quick write recipe:
```bash
mosquitto_pub -h <broker> -t "bacnetwrite/my_bacnet_gateway_1/114/1_0/85/set" -m '{"value":25.5,"priority":8}'
# Expect status on:
# bacnetwrite_status/my_bacnet_gateway_1/114/1_0/85
```

## Run with Docker

Gateway can also be run as a docker container. Just build the image and start a container:

```shell
docker build -t bacnet-mqtt-gateway
docker run -p 8082:8082 -v /mnt/bacnet-gateway/devices:/usr/src/app/devices -v /mnt/bacnet-gateway/config:/usr/src/app/config bacnet-mqtt-gateway
```

With the specified file mountings you can put the config file under `/mnt/bacnet-gateway/config` and the device configs under `/mnt/bacnet-gateway/devices` on the host system.

## Architecture Context

This gateway solves one of the core IoT platform challenges: **protocol diversity**. BACnet is the standard for building automation (HVAC, lighting, access control), but it doesn't speak cloud-native protocols. This gateway bridges that gap.

**Full architecture guide:** [IoT Platform Architecture Leadership](https://www.novatechflow.com/p/iot-platform-architecture-leadership.html)

### The Problem

IoT platforms fail when they treat protocol integration as one-off work:

> "IoT is not HTTP. Devices use MQTT, BACnet, Modbus, OPC UA, CAN, CoAP, proprietary serial frames, and edge-specific protocols. Without a unifying abstraction, teams implement one-off integrations that cannot scale or evolve."

BACnet is everywhere in commercial buildings — but it's a local network protocol with no native cloud connectivity.

### What This Gateway Does
```
BACnet Devices (HVAC, Lighting, Meters)
        │
        │  BACnet/IP
        ▼
┌───────────────────────────────────┐
│      bacnet-mqtt-gateway          │
│  ┌─────────────────────────────┐  │
│  │ Device Discovery (WhoIs)          │  │
│  │ Bounded Poll Scheduler + Backoff  │  │
│  │ SQLite Runtime State              │  │
│  │ Write Support (priority)          │  │
│  │ REST API + Web UI + Metrics       │  │
│  └─────────────────────────────┘  │
└───────────────────────────────────┘
        │
        │  MQTT (TLS optional)
        ▼
   Cloud / Home Assistant / IoT Platform
```

### Key Capabilities

- **Bidirectional** — read (polling) and write (commands) to BACnet objects
- **Home Assistant friendly** — state plus metadata topics for downstream consumers
- **Production ready** — JWT auth, SQLite runtime state, health endpoints, Prometheus metrics
- **Configurable** — per-device polling classes, schedules, freshness thresholds, write priorities, BACnet tags
- **Containerized** — Docker image + Compose for easy deployment

### Where It Fits

This gateway is a **reliability layer around a protocol bridge** — the edge layer that normalizes building automation data before it reaches your IoT platform, streaming pipeline, or data lake.
```
BACnet → bacnet-mqtt-gateway → MQTT Broker → Infinimesh / Kafka / Flink → Iceberg
```

---

**Building IoT integrations for industrial or building automation?**

→ [Consulting Services](https://www.novatechflow.com/p/consulting-services.html)  
→ [Book a call](https://cal.com/alexanderalten)
