DEV_IMAGE=bacnet-mqtt-gateway:local

.PHONY: dev-up dev-down dev-logs dev-build

dev-build:
	docker-compose build --build-arg IMAGE=$(DEV_IMAGE)

dev-up:
	docker-compose up -d --build

dev-down:
	docker-compose down

dev-logs:
	docker-compose logs -f
