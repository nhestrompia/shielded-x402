#!/usr/bin/env bash
set -euo pipefail

ANVIL_RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
ANVIL_PRIVATE_KEY="${ANVIL_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

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

echo "Deploying MockUSDC to ${ANVIL_RPC_URL}..." >&2
USDC_ADDR=$(deploy_and_extract "MockUSDC" forge create --root contracts src/mocks/MockUSDC.sol:MockUSDC \
  --rpc-url "$ANVIL_RPC_URL" \
  --private-key "$ANVIL_PRIVATE_KEY" \
  --broadcast \
  --json)

echo "Deploying MockProofVerifier..." >&2
VERIFIER_ADDR=$(deploy_and_extract "MockProofVerifier" forge create --root contracts src/verifiers/MockProofVerifier.sol:MockProofVerifier \
  --rpc-url "$ANVIL_RPC_URL" \
  --private-key "$ANVIL_PRIVATE_KEY" \
  --broadcast \
  --json)

echo "Deploying ShieldedPool with token=$USDC_ADDR verifier=$VERIFIER_ADDR" >&2
POOL_ADDR=$(deploy_and_extract "ShieldedPool" forge create --root contracts src/ShieldedPool.sol:ShieldedPool \
  --rpc-url "$ANVIL_RPC_URL" \
  --private-key "$ANVIL_PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$USDC_ADDR" "$VERIFIER_ADDR")

echo "Deploying DummyShieldedService with pool=$POOL_ADDR" >&2
DUMMY_SERVICE_ADDR=$(deploy_and_extract "DummyShieldedService" forge create --root contracts src/mocks/DummyShieldedService.sol:DummyShieldedService \
  --rpc-url "$ANVIL_RPC_URL" \
  --private-key "$ANVIL_PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$POOL_ADDR")

cat <<JSON
{
  "network": "anvil",
  "rpcUrl": "$ANVIL_RPC_URL",
  "mockUsdc": "$USDC_ADDR",
  "mockVerifier": "$VERIFIER_ADDR",
  "shieldedPool": "$POOL_ADDR",
  "dummyShieldedService": "$DUMMY_SERVICE_ADDR"
}
JSON
