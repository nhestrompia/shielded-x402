#!/usr/bin/env bash
set -euo pipefail

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"
: "${SHIELDED_POOL_ADDRESS:?SHIELDED_POOL_ADDRESS is required}"

extract_address() {
  sed -nE \
    -e 's/.*"deployedTo"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    -e 's/.*[Dd]eployed to:[[:space:]]*(0x[0-9a-fA-F]{40}).*/\1/p' | tail -n 1
}

deploy_and_extract() {
  local label="$1"
  shift
  local output
  if ! output="$("$@" 2>&1)"; then
    echo "Failed deploying ${label}" >&2
    echo "forge output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  local address
  address="$(printf '%s\n' "$output" | extract_address)"
  if [[ -z "$address" ]]; then
    echo "Failed to parse ${label} deployment address" >&2
    echo "forge output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s' "$address"
}

echo "Deploying DummyShieldedService with pool=$SHIELDED_POOL_ADDRESS" >&2
DUMMY_SERVICE_ADDR=$(deploy_and_extract "DummyShieldedService" forge create --root contracts src/mocks/DummyShieldedService.sol:DummyShieldedService \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$SHIELDED_POOL_ADDRESS")

if [[ -n "${DUMMY_RELAYER_ADDRESS:-}" ]]; then
  echo "Configuring relayer on DummyShieldedService: $DUMMY_RELAYER_ADDRESS" >&2
  cast send "$DUMMY_SERVICE_ADDR" \
    "setRelayer(address)" "$DUMMY_RELAYER_ADDRESS" \
    --rpc-url "$SEPOLIA_RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
fi

cat <<JSON
{
  "network": "sepolia",
  "shieldedPool": "$SHIELDED_POOL_ADDRESS",
  "dummyShieldedService": "$DUMMY_SERVICE_ADDR",
  "dummyRelayer": "${DUMMY_RELAYER_ADDRESS:-}"
}
JSON
