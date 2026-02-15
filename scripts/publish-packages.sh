#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/.release"
DRY_RUN=false
TAG="${NPM_TAG:-latest}"
ACCESS="${NPM_ACCESS:-public}"
CACHE_DIR="${NPM_CACHE_DIR:-${ROOT_DIR}/.npm-cache}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/publish-packages.sh [--dry-run]

Options:
  --dry-run   Build, pack, and run npm publish in dry-run mode

Env:
  NPM_TAG     npm dist-tag to publish with (default: latest)
  NPM_ACCESS  npm access level (default: public)
USAGE
}

if [[ $# -gt 1 ]]; then
  usage
  exit 1
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -eq 1 ]]; then
  usage
  exit 1
fi

echo "Preparing publish artifacts (dry-run=${DRY_RUN}, tag=${TAG}, access=${ACCESS}, cache=${CACHE_DIR})"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
mkdir -p "${CACHE_DIR}"

pushd "${ROOT_DIR}" >/dev/null

pnpm --filter @shielded-x402/shared-types build
pnpm --filter @shielded-x402/client build

SHARED_TGZ=$(pnpm --filter @shielded-x402/shared-types pack --pack-destination "${DIST_DIR}" | tail -n 1)
CLIENT_TGZ=$(pnpm --filter @shielded-x402/client pack --pack-destination "${DIST_DIR}" | tail -n 1)

if [[ ! -f "${SHARED_TGZ}" ]]; then
  echo "Missing shared-types tarball: ${SHARED_TGZ}"
  exit 1
fi
if [[ ! -f "${CLIENT_TGZ}" ]]; then
  echo "Missing client tarball: ${CLIENT_TGZ}"
  exit 1
fi

echo "Packed:"
echo "  - ${SHARED_TGZ}"
echo "  - ${CLIENT_TGZ}"

PUBLISH_ARGS=(--access "${ACCESS}" --tag "${TAG}" --cache "${CACHE_DIR}")
if [[ "${DRY_RUN}" == "true" ]]; then
  PUBLISH_ARGS+=(--dry-run)
fi

echo "Publishing @shielded-x402/shared-types..."
npm publish "${SHARED_TGZ}" "${PUBLISH_ARGS[@]}"

echo "Publishing @shielded-x402/client..."
npm publish "${CLIENT_TGZ}" "${PUBLISH_ARGS[@]}"

echo "Publish completed."
popd >/dev/null
