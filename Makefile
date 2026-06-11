DEV_IMAGE ?= bacnet-mqtt-gateway:local
ADMIN_UI_URL=http://localhost:8082/admin/
DOCKER ?= docker
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

.PHONY: dev-up dev-down dev-logs dev-build docker-ready test codeql code-ql code-ql-gate

docker-ready:
	@if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then \
		echo "Docker Compose is unavailable. Install Docker Compose v2 or docker-compose."; \
		exit 1; \
	fi
	@if ! $(DOCKER) buildx version >/dev/null 2>&1; then \
		echo "Docker Buildx is unavailable. Install Docker Buildx or update Docker Desktop/Colima."; \
		exit 1; \
	fi
	@if ! $(DOCKER) info >/dev/null 2>&1; then \
		if command -v colima >/dev/null 2>&1; then \
			echo "Docker daemon is unavailable; starting Colima..."; \
			colima start; \
		else \
			echo "Docker daemon is unavailable. Start Docker Desktop or set DOCKER_HOST to a running Docker daemon."; \
			exit 1; \
		fi; \
	fi

dev-build: docker-ready
	$(DOCKER) buildx build --load --tag $(DEV_IMAGE) .

dev-up: dev-build
	DEV_IMAGE=$(DEV_IMAGE) $(COMPOSE) up -d
	@if command -v open >/dev/null 2>&1; then \
		open "$(ADMIN_UI_URL)"; \
	elif command -v xdg-open >/dev/null 2>&1; then \
		xdg-open "$(ADMIN_UI_URL)" >/dev/null 2>&1 || true; \
	else \
		echo "Admin UI: $(ADMIN_UI_URL)"; \
	fi

dev-down: docker-ready
	DEV_IMAGE=$(DEV_IMAGE) $(COMPOSE) down

dev-logs: docker-ready
	DEV_IMAGE=$(DEV_IMAGE) $(COMPOSE) logs -f

test:
	node --check web/admin.js
	npm test -- --coverage

codeql:
	bash scripts/run_codeql.sh
	@jq -r '.runs[]?.results[]? | "\(.level // "warning")\t\(.ruleId // "no-rule")\t\(.locations[0].physicalLocation.artifactLocation.uri // "unknown"):\(.locations[0].physicalLocation.region.startLine // 0)\t\(.message.text // "no-message")"' artifacts/codeql/*.sarif | sort || true

code-ql: codeql

code-ql-gate: codeql
	@errors=$$(jq '[.runs[]?.results[]? | select((.level // "warning") == "error")] | length' artifacts/codeql/*.sarif | awk '{s+=$$1} END{print s+0}'); \
	if [ "$$errors" -gt 0 ]; then \
		echo "CodeQL gate failed: $$errors error finding(s) found."; \
		exit 1; \
	fi; \
	echo "CodeQL gate passed: no error findings found."
