#!/usr/bin/env bash
set -euo pipefail

CIRCUIT_DIR="${1:-circuits/spend_change}"
OUTPUT_FILE="${2:-ops/fixtures/sepolia-payment-response.json}"
WITNESS_NAME="${3:-witness}"

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

resolve_vk_path() {
  if [[ -f "./target/vk/vk" ]]; then
    echo "./target/vk/vk"
    return 0
  fi
  if [[ -f "./target/vk" ]]; then
    echo "./target/vk"
    return 0
  fi
  return 1
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

pushd "$CIRCUIT_DIR" >/dev/null

"$NARGO_BIN" check
"$NARGO_BIN" compile
EXECUTE_OUTPUT="$("$NARGO_BIN" execute "$WITNESS_NAME" 2>&1)"
printf '%s\n' "$EXECUTE_OUTPUT"

prove_errors_log="./target/prove-errors.log"
rm -f "$prove_errors_log"
WITNESS_PATH="./target/${WITNESS_NAME}.gz"
if [[ ! -f "$WITNESS_PATH" ]]; then
  echo "Could not find witness output at ${WITNESS_PATH}"
  ls -la ./target
  exit 1
fi

# Ensure a verification key exists and resolve the concrete file path expected by bb prove.
VK_PATH="$(resolve_vk_path || true)"
if [[ -z "$VK_PATH" ]]; then
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
  VK_PATH="$(resolve_vk_path || true)"
fi

if [[ -z "$VK_PATH" ]]; then
  echo "Failed to locate verification key output in $CIRCUIT_DIR/target"
  ls -la ./target
  exit 1
fi

# Ensure bb can write its standard output files.
rm -rf ./target/proof ./target/public_inputs

prove_cmd=(
  "$BB_BIN" "prove"
  -b "./target/spend_change.json"
  -w "$WITNESS_PATH"
  -o "./target"
)
if has_flag "prove" "--scheme"; then
  prove_cmd+=("--scheme" "ultra_honk")
fi
if has_flag "prove" "-k"; then
  prove_cmd+=("-k" "$VK_PATH")
fi
target_flag=""
if has_flag "prove" "--verifier_target"; then
  prove_cmd+=("--verifier_target" "evm")
  target_flag="--verifier_target"
elif has_flag "prove" "-t"; then
  prove_cmd+=("-t" "evm")
  target_flag="-t"
fi
oracle_hash_value="${BB_ORACLE_HASH:-keccak}"
if has_flag "prove" "--oracle_hash"; then
  prove_cmd+=("--oracle_hash" "$oracle_hash_value")
fi

echo "Trying: ${prove_cmd[*]}"
if ! "${prove_cmd[@]}" 2> >(tee -a "$prove_errors_log" >&2); then
  if [[ -n "$target_flag" ]]; then
    echo "Primary prove target 'evm' failed; retrying with 'evm-no-zk'."
    for i in "${!prove_cmd[@]}"; do
      if [[ "${prove_cmd[$i]}" == "$target_flag" ]]; then
        prove_cmd[$((i + 1))]="evm-no-zk"
        break
      fi
    done
    if "${prove_cmd[@]}" 2> >(tee -a "$prove_errors_log" >&2); then
      true
    else
      echo "Failed to generate proof with available bb prove commands."
      if [[ -f "$prove_errors_log" ]] && grep -E -q "val\\.on_curve|Conversion error here usually implies some bad proof serde|fr_vec\\[" "$prove_errors_log"; then
        echo ""
        echo "Detected bb prove serialization/on-curve failure pattern."
        echo "Recommended fix: align bb with your Noir release."
        echo "Run:"
        echo "  PATH=\"$HOME/.nargo/bin:\$PATH\" ~/.bb/bbup -nv 1.0.0-beta.18"
        echo "Then verify:"
        echo "  ~/.bb/bb --version"
        echo "And retry:"
        echo "  pnpm circuit:verifier && pnpm circuit:fixture"
      fi
      exit 1
    fi
  else
    echo "Failed to generate proof with available bb prove commands."
    if [[ -f "$prove_errors_log" ]] && grep -E -q "val\\.on_curve|Conversion error here usually implies some bad proof serde|fr_vec\\[" "$prove_errors_log"; then
      echo ""
      echo "Detected bb prove serialization/on-curve failure pattern."
      echo "Recommended fix: align bb with your Noir release."
      echo "Run:"
      echo "  PATH=\"$HOME/.nargo/bin:\$PATH\" ~/.bb/bbup -nv 1.0.0-beta.18"
      echo "Then verify:"
      echo "  ~/.bb/bb --version"
      echo "And retry:"
      echo "  pnpm circuit:verifier && pnpm circuit:fixture"
    fi
    exit 1
  fi
fi

if [[ ! -f ./target/proof ]]; then
  echo "Failed to generate proof with available bb prove commands."
  exit 1
fi

PROOF_FILE=""
PUBLIC_INPUTS_FILE=""
for candidate in ./target/proof ./target/proofs ./target/proof.txt ./target/proof.bin ./target/proof_fields.json; do
  if [[ -f "$candidate" ]]; then
    PROOF_FILE="$candidate"
    break
  fi
done
for candidate in ./target/public_inputs ./target/public-inputs ./target/public_inputs.txt; do
  if [[ -f "$candidate" ]]; then
    PUBLIC_INPUTS_FILE="$candidate"
    break
  fi
done

if [[ -z "$PROOF_FILE" ]]; then
  echo "Failed to locate proof output in $CIRCUIT_DIR/target"
  ls -la ./target
  exit 1
fi

if [[ -z "$PUBLIC_INPUTS_FILE" ]]; then
  TUPLE_OUTPUT="$(printf '%s\n' "$EXECUTE_OUTPUT" | sed -n 's/.*Circuit output: //p' | tail -n1)"
  if [[ -z "$TUPLE_OUTPUT" ]]; then
    echo "Failed to locate public inputs output in $CIRCUIT_DIR/target and could not parse nargo circuit output"
    ls -la ./target
    exit 1
  fi
  PUBLIC_INPUTS_FILE="./target/public_inputs.from_execute.json"
  node ../../scripts/tuple-output-to-public-inputs.mjs "$TUPLE_OUTPUT" "$PUBLIC_INPUTS_FILE"
fi

if [[ -z "$PROOF_FILE" || -z "$PUBLIC_INPUTS_FILE" ]]; then
  echo "Failed to locate proof/public inputs output in $CIRCUIT_DIR/target"
  ls -la ./target
  exit 1
fi

popd >/dev/null

node scripts/build-payment-fixture.mjs \
  "$CIRCUIT_DIR/${PROOF_FILE#./}" \
  "$CIRCUIT_DIR/${PUBLIC_INPUTS_FILE#./}" \
  "$OUTPUT_FILE"
