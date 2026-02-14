#!/usr/bin/env bash
set -euo pipefail

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"
: "${USDC_ADDRESS:?USDC_ADDRESS is required}"

VERIFIER_SRC="contracts/generated/UltraVerifier.sol"
if [[ ! -f "$VERIFIER_SRC" ]]; then
  echo "Generated verifier not found at $VERIFIER_SRC"
  echo "Run: pnpm circuit:verifier"
  exit 1
fi

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

echo "Deploying generated UltraVerifier..." >&2
ULTRA_VERIFIER_ADDR=$(deploy_and_extract "UltraVerifier" forge create --root contracts generated/UltraVerifier.sol:UltraVerifier \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --json)

echo "Deploying NoirVerifierAdapter for UltraVerifier=$ULTRA_VERIFIER_ADDR" >&2
ADAPTER_ADDR=$(deploy_and_extract "NoirVerifierAdapter" forge create --root contracts src/verifiers/NoirVerifierAdapter.sol:NoirVerifierAdapter \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$ULTRA_VERIFIER_ADDR")

echo "Deploying ShieldedPool with token=$USDC_ADDRESS verifier(adapter)=$ADAPTER_ADDR" >&2
POOL_ADDR=$(deploy_and_extract "ShieldedPool" forge create --root contracts src/ShieldedPool.sol:ShieldedPool \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$USDC_ADDRESS" "$ADAPTER_ADDR")

cat <<JSON
{
  "ultraVerifier": "$ULTRA_VERIFIER_ADDR",
  "verifierAdapter": "$ADAPTER_ADDR",
  "shieldedPool": "$POOL_ADDR",
  "usdc": "$USDC_ADDRESS"
}
JSON
