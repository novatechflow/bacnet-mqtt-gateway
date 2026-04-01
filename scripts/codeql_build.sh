#!/usr/bin/env bash
set -euo pipefail

npm install --ignore-scripts
npm test -- --runInBand --testPathIgnorePatterns=.codeql-db --coverage=false
