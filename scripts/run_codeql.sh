#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_DIR="${TMPDIR:-/tmp}/bacnet-mqtt-gateway-codeql-db"
OUT_DIR="${ROOT_DIR}/artifacts/codeql"
OUT_FILE="${OUT_DIR}/results.sarif"

if ! command -v codeql >/dev/null 2>&1; then
  echo "codeql CLI not found in PATH" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
rm -rf "${DB_DIR}"

cd "${ROOT_DIR}"

rm -rf coverage

codeql database create "${DB_DIR}" \
  --language=javascript-typescript \
  --source-root="${ROOT_DIR}" \
  --command="${ROOT_DIR}/scripts/codeql_build.sh"

codeql database analyze "${DB_DIR}" \
  codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls \
  --format=sarif-latest \
  --output="${OUT_FILE}"

echo "CodeQL results written to ${OUT_FILE}"
