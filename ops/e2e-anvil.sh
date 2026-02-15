#!/usr/bin/env bash
set -euo pipefail

ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:${ANVIL_PORT}}"
ANVIL_PRIVATE_KEY="${ANVIL_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
GATEWAY_PORT="${PORT:-3000}"
GATEWAY_URL="${E2E_GATEWAY_URL:-http://127.0.0.1:${GATEWAY_PORT}}"
FIXED_CHALLENGE_NONCE="${FIXED_CHALLENGE_NONCE:-0x9999999999999999999999999999999999999999999999999999999999999999}"
PAYMENT_VERIFYING_CONTRACT="${PAYMENT_VERIFYING_CONTRACT:-0x0000000000000000000000000000000000000002}"
E2E_PAYER_PRIVATE_KEY="${E2E_PAYER_PRIVATE_KEY:-$ANVIL_PRIVATE_KEY}"
E2E_PAYMENT_RESPONSE_FILE="${E2E_PAYMENT_RESPONSE_FILE:-$(pwd)/ops/fixtures/sepolia-payment-response.json}"
ANVIL_LOG="${ANVIL_LOG:-/tmp/shielded-402-anvil.log}"
GATEWAY_LOG="${GATEWAY_LOG:-/tmp/shielded-402-gateway.log}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd anvil
require_cmd cast
require_cmd node
require_cmd pnpm
require_cmd curl

rpc_ready() {
  local response
  response="$(
    curl -sS \
      -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "$ANVIL_RPC_URL" 2>/dev/null || true
  )"
  [[ "$response" == *'"result":"0x'* ]]
}

if [[ "$E2E_PAYMENT_RESPONSE_FILE" == /ops/* ]]; then
  E2E_PAYMENT_RESPONSE_FILE="$(pwd)${E2E_PAYMENT_RESPONSE_FILE}"
elif [[ "$E2E_PAYMENT_RESPONSE_FILE" != /* ]]; then
  E2E_PAYMENT_RESPONSE_FILE="$(pwd)/${E2E_PAYMENT_RESPONSE_FILE}"
fi

ANVIL_PID=""
GATEWAY_PID=""
cleanup() {
  if [[ -n "$GATEWAY_PID" ]]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ANVIL_PID" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Starting Anvil on ${ANVIL_RPC_URL}"
anvil --chain-id 31337 --host 127.0.0.1 --port "$ANVIL_PORT" --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!

for _ in {1..30}; do
  if rpc_ready; then
    break
  fi
  sleep 0.5
done
if ! rpc_ready; then
  echo "Anvil did not become ready; log at $ANVIL_LOG"
  exit 1
fi

echo "Generating fresh proof fixture"
pnpm circuit:fixture >/dev/null

echo "Deploying local contracts"
DEPLOY_JSON="$(
  ANVIL_RPC_URL="$ANVIL_RPC_URL" ANVIL_PRIVATE_KEY="$ANVIL_PRIVATE_KEY" bash ops/deploy-anvil-dummy.sh
)"
USDC_ADDR="$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mockUsdc)' "$DEPLOY_JSON")"
VERIFIER_ADDR="$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.mockVerifier)' "$DEPLOY_JSON")"
POOL_ADDR="$(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.shieldedPool)' "$DEPLOY_JSON")"

word_32() {
  printf "%064x" "$1"
}

# Fixture note in Prover.toml: amount=100, rho=42, pkHash=11.
COMMITMENT_PREIMAGE="0x$(word_32 100)$(word_32 42)$(word_32 11)"
COMMITMENT="$(cast keccak "$COMMITMENT_PREIMAGE")"
DEPLOYER_ADDR="$(cast wallet address --private-key "$ANVIL_PRIVATE_KEY")"

echo "Seeding pool with fixture commitment root"
cast send "$USDC_ADDR" "mint(address,uint256)" "$DEPLOYER_ADDR" 1000000 \
  --rpc-url "$ANVIL_RPC_URL" --private-key "$ANVIL_PRIVATE_KEY" >/dev/null
cast send "$USDC_ADDR" "approve(address,uint256)" "$POOL_ADDR" 1000000 \
  --rpc-url "$ANVIL_RPC_URL" --private-key "$ANVIL_PRIVATE_KEY" >/dev/null
cast send "$POOL_ADDR" "deposit(uint256,bytes32)" 100 "$COMMITMENT" \
  --rpc-url "$ANVIL_RPC_URL" --private-key "$ANVIL_PRIVATE_KEY" >/dev/null

FIXTURE_ROOT="$(node -e 'const fs=require("fs");const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(f.root);' "$E2E_PAYMENT_RESPONSE_FILE")"
CHAIN_ROOT="$(cast call "$POOL_ADDR" "latestRoot()(bytes32)" --rpc-url "$ANVIL_RPC_URL")"
FIXTURE_ROOT_NORM="$(printf '%s' "$FIXTURE_ROOT" | tr '[:upper:]' '[:lower:]')"
CHAIN_ROOT_NORM="$(printf '%s' "$CHAIN_ROOT" | tr '[:upper:]' '[:lower:]')"

if [[ "$FIXTURE_ROOT_NORM" != "$CHAIN_ROOT_NORM" ]]; then
  echo "Fixture root mismatch after seed"
  echo "fixture: $FIXTURE_ROOT"
  echo "chain:   $CHAIN_ROOT"
  exit 1
fi

echo "Starting merchant gateway on ${GATEWAY_URL}"
PORT="$GATEWAY_PORT" \
SEPOLIA_RPC_URL="$ANVIL_RPC_URL" \
SHIELDED_POOL_ADDRESS="$POOL_ADDR" \
ULTRA_VERIFIER_ADDRESS="$VERIFIER_ADDR" \
FIXED_CHALLENGE_NONCE="$FIXED_CHALLENGE_NONCE" \
PAYMENT_VERIFYING_CONTRACT="$PAYMENT_VERIFYING_CONTRACT" \
PRICE_USDC_MICROS="40" \
CHALLENGE_TTL_MS="${CHALLENGE_TTL_MS:-240000}" \
PAYMENT_RELAYER_PRIVATE_KEY="$ANVIL_PRIVATE_KEY" \
NODE_OPTIONS="--max-http-header-size=65536 ${NODE_OPTIONS:-}" \
pnpm --filter @shielded-x402/merchant-gateway dev >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

for _ in {1..40}; do
  if curl -fsS "${GATEWAY_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -fsS "${GATEWAY_URL}/health" >/dev/null 2>&1; then
  echo "Gateway did not become ready; log at $GATEWAY_LOG"
  exit 1
fi

echo "Running anvil live e2e test"
E2E_GATEWAY_URL="$GATEWAY_URL" \
ANVIL_RPC_URL="$ANVIL_RPC_URL" \
SHIELDED_POOL_ADDRESS="$POOL_ADDR" \
E2E_PAYER_PRIVATE_KEY="$E2E_PAYER_PRIVATE_KEY" \
FIXED_CHALLENGE_NONCE="$FIXED_CHALLENGE_NONCE" \
E2E_PAYMENT_RESPONSE_FILE="$E2E_PAYMENT_RESPONSE_FILE" \
pnpm test:anvil-live

cat <<OUT
anvil e2e completed
pool: $POOL_ADDR
verifier: $VERIFIER_ADDR
usdc: $USDC_ADDR
OUT
