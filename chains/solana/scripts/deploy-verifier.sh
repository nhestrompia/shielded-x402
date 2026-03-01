#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CIRCUIT_DIR="$ROOT_DIR/chains/solana/circuits/smt_exclusion"
TARGET_DIR="$CIRCUIT_DIR/target"

SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}"
SOLANA_DEPLOYER_KEYPAIR="${SOLANA_DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}"
SOLANA_VERIFIER_PROGRAM_KEYPAIR="${SOLANA_VERIFIER_PROGRAM_KEYPAIR:-$TARGET_DIR/smt_exclusion-keypair.json}"

for cmd in nargo sunspot solana; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$SOLANA_DEPLOYER_KEYPAIR" ]]; then
  echo "missing SOLANA_DEPLOYER_KEYPAIR file: $SOLANA_DEPLOYER_KEYPAIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

echo "[solana] compiling/proving Noir circuit (smt_exclusion)"
(
  cd "$CIRCUIT_DIR"
  nargo compile
  nargo execute
  sunspot compile target/smt_exclusion.json
  sunspot setup target/smt_exclusion.ccs
  sunspot prove target/smt_exclusion.json target/smt_exclusion.gz target/smt_exclusion.ccs target/smt_exclusion.pk
  sunspot deploy target/smt_exclusion.vk
)

if [[ ! -f "$TARGET_DIR/smt_exclusion.so" ]]; then
  echo "sunspot deploy did not produce $TARGET_DIR/smt_exclusion.so" >&2
  exit 1
fi

if [[ ! -f "$SOLANA_VERIFIER_PROGRAM_KEYPAIR" ]]; then
  echo "missing verifier program keypair: $SOLANA_VERIFIER_PROGRAM_KEYPAIR" >&2
  echo "set SOLANA_VERIFIER_PROGRAM_KEYPAIR explicitly if your Sunspot output differs" >&2
  exit 1
fi

echo "[solana] deploying verifier program to $SOLANA_CLUSTER"
solana program deploy \
  "$TARGET_DIR/smt_exclusion.so" \
  --program-id "$SOLANA_VERIFIER_PROGRAM_KEYPAIR" \
  --keypair "$SOLANA_DEPLOYER_KEYPAIR" \
  --url "$SOLANA_CLUSTER"

VERIFIER_PROGRAM_ID="$(solana address -k "$SOLANA_VERIFIER_PROGRAM_KEYPAIR")"

echo
echo "Verifier deploy complete."
echo "SOLANA_VERIFIER_PROGRAM_ID=$VERIFIER_PROGRAM_ID"
echo "Proof path: $TARGET_DIR/smt_exclusion.proof"
echo "Witness path: $TARGET_DIR/smt_exclusion.pw"
