DEV_IMAGE=bacnet-mqtt-gateway:local
ADMIN_UI_URL=http://localhost:8082/admin/

.PHONY: dev-up dev-down dev-logs dev-build test codeql code-ql code-ql-gate

dev-build:
	docker-compose build --build-arg IMAGE=$(DEV_IMAGE)

dev-up:
	docker-compose up -d --build
	@if command -v open >/dev/null 2>&1; then \
		open "$(ADMIN_UI_URL)"; \
	elif command -v xdg-open >/dev/null 2>&1; then \
		xdg-open "$(ADMIN_UI_URL)" >/dev/null 2>&1 || true; \
	else \
		echo "Admin UI: $(ADMIN_UI_URL)"; \
	fi

dev-down:
	docker-compose down

dev-logs:
	docker-compose logs -f

test:
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
