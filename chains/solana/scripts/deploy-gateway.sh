#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROGRAM_DIR="$ROOT_DIR/chains/solana/programs/x402_gateway"
DEPLOY_DIR="$PROGRAM_DIR/target/deploy"

SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}"
SOLANA_DEPLOYER_KEYPAIR="${SOLANA_DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}"
SOLANA_GATEWAY_PROGRAM_KEYPAIR="${SOLANA_GATEWAY_PROGRAM_KEYPAIR:-$DEPLOY_DIR/x402_gateway-keypair.json}"

for cmd in cargo solana; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$SOLANA_DEPLOYER_KEYPAIR" ]]; then
  echo "missing SOLANA_DEPLOYER_KEYPAIR file: $SOLANA_DEPLOYER_KEYPAIR" >&2
  exit 1
fi

echo "[solana] building x402_gateway program"
cargo build-sbf --manifest-path "$PROGRAM_DIR/Cargo.toml"

if [[ ! -f "$DEPLOY_DIR/x402_gateway.so" ]]; then
  echo "missing compiled program artifact: $DEPLOY_DIR/x402_gateway.so" >&2
  exit 1
fi

if [[ ! -f "$SOLANA_GATEWAY_PROGRAM_KEYPAIR" ]]; then
  echo "missing gateway program keypair: $SOLANA_GATEWAY_PROGRAM_KEYPAIR" >&2
  echo "set SOLANA_GATEWAY_PROGRAM_KEYPAIR explicitly if your build output differs" >&2
  exit 1
fi

echo "[solana] deploying x402_gateway to $SOLANA_CLUSTER"
solana program deploy \
  "$DEPLOY_DIR/x402_gateway.so" \
  --program-id "$SOLANA_GATEWAY_PROGRAM_KEYPAIR" \
  --keypair "$SOLANA_DEPLOYER_KEYPAIR" \
  --url "$SOLANA_CLUSTER"

GATEWAY_PROGRAM_ID="$(solana address -k "$SOLANA_GATEWAY_PROGRAM_KEYPAIR")"

echo
echo "Gateway deploy complete."
echo "SOLANA_GATEWAY_PROGRAM_ID=$GATEWAY_PROGRAM_ID"
