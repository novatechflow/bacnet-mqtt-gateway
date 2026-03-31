# Changelog

## V1.6.0

- Reworked BACnet polling into a bounded scheduler with queueing, device-class intervals, exponential backoff, and circuit breaking to protect large deployments from poll storms.
- Added SQLite-backed runtime state in `data/runtime.db` to persist device health, last successful polls, and object freshness metadata across restarts.
- Expanded MQTT output from raw Home Assistant state only to a richer production contract with canonical telemetry topics plus HA attributes topics carrying timestamps and health context.
- Added runtime and observability improvements: richer `/health`, expanded Prometheus `/metrics`, and a new `/api/bacnet/runtime` endpoint.
- Extended polling config to support `class`, `intervalMs`, and `freshnessMs`, and updated validation/docs around large-scale production tuning.
- Added broader automated test coverage for BACnet polling, MQTT telemetry publishing, runtime state persistence, server metrics, and shared model helpers.

## V1.5.3

- Fix tar vulnerability by pinning tar to 7.5.3 via npm overrides.

## V1.5.2

- Fix BACnet write failures when request options are missing and document BACnet request tuning (max segments/APDU).

## V1.5.1

- Fix admin login on non-secure contexts by falling back when Web Crypto is unavailable. (#34)

## V1.5

- Added built-in user management backed by SQLite with JWT + refresh tokens, role-based access (admin/viewer), and change-password flow; initial admin password is randomly seeded.
- Protected API routes with bearer auth; login/register/refresh/change-password endpoints added.
- Enhanced admin UI with login/logout, encrypted token storage, change-password modal, health status bar, and configured devices view.
- Improved MQTT handling: optional TLS config (CA/cert/key), connection status exposed via `/health` and `/metrics`.
- Added Docker Compose setup with Mosquitto, sample device config, and Makefile helpers for local dev; compose now builds a local image tag by default.
- New health/metrics endpoints and stricter server-side validation; safer config file handling and polling guards.
