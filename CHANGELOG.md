# Changelog

## V1.5.1

- Fix admin login on non-secure contexts by falling back when Web Crypto is unavailable. (#34)

## V1.5

- Added built-in user management backed by SQLite with JWT + refresh tokens, role-based access (admin/viewer), and change-password flow; initial admin password is randomly seeded.
- Protected API routes with bearer auth; login/register/refresh/change-password endpoints added.
- Enhanced admin UI with login/logout, encrypted token storage, change-password modal, health status bar, and configured devices view.
- Improved MQTT handling: optional TLS config (CA/cert/key), connection status exposed via `/health` and `/metrics`.
- Added Docker Compose setup with Mosquitto, sample device config, and Makefile helpers for local dev; compose now builds a local image tag by default.
- New health/metrics endpoints and stricter server-side validation; safer config file handling and polling guards.
