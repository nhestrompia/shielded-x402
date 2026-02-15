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

detect_verifier_contract_name() {
  local name
  name="$(sed -nE 's/^[[:space:]]*contract[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*/\1/p' "$VERIFIER_SRC" | tail -n 1)"
  if [[ -z "$name" ]]; then
    echo "UltraVerifier"
    return 0
  fi
  echo "$name"
}

extract_address() {
  sed -nE \
    -e 's/.*"deployedTo"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    -e 's/.*[Dd]eployed to:[[:space:]]*(0x[0-9a-fA-F]{40}).*/\1/p' | tail -n 1
}

join_by_comma() {
  local IFS=","
  echo "$*"
}

parse_required_libraries() {
  printf '%s\n' "$1" | sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*:[[:space:]]+(contracts\/)?generated\/UltraVerifier\.sol[[:space:]]*$/\1/p'
}

deploy_generated_symbol() {
  local symbol="$1"
  local flags="$2"

  local output
  local address
  local -a cmd=(
    forge create --root contracts "generated/UltraVerifier.sol:${symbol}"
    --rpc-url "$SEPOLIA_RPC_URL"
    --private-key "$DEPLOYER_PRIVATE_KEY"
    --broadcast
    --json
  )
  local -a flag_args=()
  if [[ -n "$flags" ]]; then
    read -r -a flag_args <<<"$flags"
    cmd+=("${flag_args[@]}")
  fi

  if ! output="$("${cmd[@]}" 2>&1)"; then
    echo "Failed deploying generated symbol ${symbol}" >&2
    echo "forge output:" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  address="$(printf '%s\n' "$output" | extract_address)"
  if [[ -z "$address" ]]; then
    echo "Failed to parse deployment address for generated symbol ${symbol}" >&2
    echo "forge output:" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  printf '%s' "$address"
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

deploy_ultra_verifier() {
  local verifier_contract_name="$1"
  local attempts=(
    "--use 0.8.29 --optimize true --optimizer-runs 1"
    "--use 0.8.29 --optimize true --optimizer-runs 10"
    "--use 0.8.29"
    "--use 0.8.29 --optimize false"
    "--via-ir --optimize false --use 0.8.29"
    "--via-ir --optimize false --use 0.8.30"
    "--via-ir --use 0.8.30"
    "--via-ir --use 0.8.29"
  )

  local flags
  local output
  local address
  local -a lib_names=()
  local -a lib_addresses=()
  local lib
  local lib_addr
  local has_lib
  local i
  local progress
  local -a mappings=()

  for flags in "${attempts[@]}"; do
    echo "Deploying generated ${verifier_contract_name} with flags: ${flags}" >&2
    lib_names=()
    lib_addresses=()

    for _ in 1 2 3 4; do
      local -a cmd=(
        forge create --root contracts "generated/UltraVerifier.sol:${verifier_contract_name}"
        --rpc-url "$SEPOLIA_RPC_URL"
        --private-key "$DEPLOYER_PRIVATE_KEY"
        --broadcast
        --json
      )
      local -a flag_args=()
      if [[ -n "$flags" ]]; then
        read -r -a flag_args <<<"$flags"
        cmd+=("${flag_args[@]}")
      fi
      mappings=()
      for i in "${!lib_names[@]}"; do
        mappings+=("generated/UltraVerifier.sol:${lib_names[$i]}:${lib_addresses[$i]}")
      done
      if [[ "${#mappings[@]}" -gt 0 ]]; then
        cmd+=(--libraries "$(join_by_comma "${mappings[@]}")")
      fi

      if output="$("${cmd[@]}" 2>&1)"; then
        address="$(printf '%s\n' "$output" | extract_address)"
        if [[ -n "$address" ]]; then
          printf '%s' "$address"
          return 0
        fi
        echo "Failed to parse UltraVerifier deployment address" >&2
        echo "forge output:" >&2
        printf '%s\n' "$output" >&2
        break
      fi

      if grep -q "Dynamic linking not supported in \`create\` command" <<<"$output"; then
        progress=0
        while IFS= read -r lib; do
          [[ -z "$lib" ]] && continue
          has_lib=0
          for i in "${!lib_names[@]}"; do
            if [[ "${lib_names[$i]}" == "$lib" ]]; then
              has_lib=1
              break
            fi
          done
          if [[ "$has_lib" -eq 1 ]]; then
            continue
          fi
          echo "Deploying required verifier library ${lib}" >&2
          if ! lib_addr="$(deploy_generated_symbol "$lib" "$flags")"; then
            progress=-1
            break
          fi
          lib_names+=("$lib")
          lib_addresses+=("$lib_addr")
          progress=1
        done < <(parse_required_libraries "$output")

        if [[ "$progress" -gt 0 ]]; then
          continue
        fi
      fi

      echo "UltraVerifier deployment attempt failed" >&2
      echo "forge output:" >&2
      printf '%s\n' "$output" >&2
      break
    done
  done

  return 1
}

VERIFIER_CONTRACT_NAME="$(detect_verifier_contract_name)"
echo "Detected verifier contract name: ${VERIFIER_CONTRACT_NAME}" >&2
ULTRA_VERIFIER_ADDR="$(deploy_ultra_verifier "$VERIFIER_CONTRACT_NAME" || true)"
if [[ -z "$ULTRA_VERIFIER_ADDR" ]]; then
  echo "Failed deploying UltraVerifier after trying multiple compile profiles." >&2
  exit 1
fi

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
