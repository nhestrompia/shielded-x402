#!/usr/bin/env bash
set -euo pipefail

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

NARGO_BIN="$(resolve_cmd "nargo" "$HOME/.nargo/bin/nargo" || true)"
if [[ -z "$NARGO_BIN" ]]; then
  echo "nargo missing; skipping circuit checks"
  exit 0
fi

cd circuits/spend_change

echo "Running nargo check"
"$NARGO_BIN" check

echo "Circuit check completed"
