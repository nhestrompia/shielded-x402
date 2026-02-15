#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "${ROOT_DIR}/dist"
pnpm exec tsc -p "${ROOT_DIR}/tsconfig.json"

mkdir -p "${ROOT_DIR}/dist/circuits"
cp "${ROOT_DIR}/src/circuits/spend_change.json" "${ROOT_DIR}/dist/circuits/spend_change.json"

