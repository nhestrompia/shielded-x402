#!/usr/bin/env bash
set -euo pipefail

CIRCUIT_DIR="${1:-circuits/spend_change}"
OUT_DIR="${2:-contracts/generated}"

resolve_cmd() {
  local cmd="$1"
  local fallback="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    command -v "$cmd"
    return 0
  fi
  if [[ -x "$fallback" ]]; then
    echo "$fallback"
    return 0
  fi
  return 1
}

has_subcommand() {
  local cmd="$1"
  local help_text
  help_text="$("$BB_BIN" --help 2>/dev/null || true)"
  grep -E -q "(^|[[:space:]])${cmd}([[:space:]]|$)" <<<"$help_text"
}

has_flag() {
  local cmd="$1"
  local flag="$2"
  local help_text
  help_text="$("$BB_BIN" "$cmd" --help 2>/dev/null || true)"
  grep -q -- "$flag" <<<"$help_text"
}

NARGO_BIN="$(resolve_cmd "nargo" "$HOME/.nargo/bin/nargo" || true)"
BB_BIN="$(resolve_cmd "bb" "$HOME/.bb/bb" || true)"

if [[ -z "$NARGO_BIN" ]]; then
  echo "nargo is required"
  echo "Install Noir via noirup: https://noir-lang.org/docs/getting_started/quick_start"
  exit 1
fi

if [[ -z "$BB_BIN" ]]; then
  echo "bb is required"
  echo "Install Barretenberg with: bbup"
  echo "Then ensure '$HOME/.bb' is on PATH or re-open your shell."
  exit 1
fi

mkdir -p "$OUT_DIR"
pushd "$CIRCUIT_DIR" >/dev/null

"$NARGO_BIN" compile
"$NARGO_BIN" execute witness

# Generate verification key.
vk_cmd=("$BB_BIN" "write_vk" "-b" "./target/spend_change.json" "-o" "./target/vk")
if has_flag "write_vk" "--scheme"; then
  vk_cmd+=("--scheme" "ultra_honk")
fi
if has_flag "write_vk" "--verifier_target"; then
  vk_cmd+=("--verifier_target" "evm")
elif has_flag "write_vk" "-t"; then
  vk_cmd+=("-t" "evm")
fi
oracle_hash_value="${BB_ORACLE_HASH:-keccak}"
if has_flag "write_vk" "--oracle_hash"; then
  vk_cmd+=("--oracle_hash" "$oracle_hash_value")
fi
"${vk_cmd[@]}"

VK_PATH="./target/vk"
if [[ -f "./target/vk/vk" ]]; then
  VK_PATH="./target/vk/vk"
fi

# Generate Solidity verifier (support both new and old bb command names).
if has_subcommand "write_solidity_verifier"; then
  contract_cmd=(
    "$BB_BIN" "write_solidity_verifier"
    "-k" "$VK_PATH"
    "-o" "./target/UltraVerifier.sol"
  )
  if has_flag "write_solidity_verifier" "-b"; then
    contract_cmd+=("-b" "./target/spend_change.json")
  fi
  target_flag=""
  target_value="evm"
  if has_flag "write_solidity_verifier" "--verifier_target"; then
    contract_cmd+=("--verifier_target" "$target_value")
    target_flag="--verifier_target"
  elif has_flag "write_solidity_verifier" "-t"; then
    contract_cmd+=("-t" "$target_value")
    target_flag="-t"
  fi
  if has_flag "write_solidity_verifier" "--scheme"; then
    contract_cmd+=("--scheme" "ultra_honk")
  fi
  if [[ -n "${BB_CRS_PATH:-}" ]] && has_flag "write_solidity_verifier" "-c"; then
    contract_cmd+=("-c" "$BB_CRS_PATH")
  fi
  if [[ -n "$target_flag" ]]; then
    if ! "${contract_cmd[@]}"; then
      echo "Primary target '${target_value}' failed; retrying with 'evm-no-zk'."
      for i in "${!contract_cmd[@]}"; do
        if [[ "${contract_cmd[$i]}" == "$target_flag" ]]; then
          contract_cmd[$((i + 1))]="evm-no-zk"
          break
        fi
      done
      "${contract_cmd[@]}"
    fi
  else
    "${contract_cmd[@]}"
  fi
else
  "$BB_BIN" contract -k "$VK_PATH" -o ./target/UltraVerifier.sol
fi

cp ./target/UltraVerifier.sol "../../$OUT_DIR/UltraVerifier.sol"

# bb may emit mixed pragma declarations including ^0.8.27 in embedded libs.
# Keep generated verifier compatible with project compiler pin (0.8.26).
sed -i.bak -E 's/pragma solidity \^0\.8\.[0-9]+;/pragma solidity >=0.8.21;/g' "../../$OUT_DIR/UltraVerifier.sol"
rm -f "../../$OUT_DIR/UltraVerifier.sol.bak"

popd >/dev/null

echo "Generated verifier at $OUT_DIR/UltraVerifier.sol"
