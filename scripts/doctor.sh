#!/usr/bin/env bash
set -euo pipefail

check_cmd() {
  local cmd="$1"
  local fallback="${2:-}"
  local cmd_path=""
  if command -v "$cmd" >/dev/null 2>&1; then
    cmd_path="$(command -v "$cmd")"
  elif [[ -n "$fallback" && -x "$fallback" ]]; then
    cmd_path="$fallback"
  fi

  if [[ -z "$cmd_path" ]]; then
    echo "[missing] $cmd"
    return 1
  fi
  echo "[ok] $cmd -> $("$cmd_path" --version 2>/dev/null | head -n1 || true)"
  return 0
}

status=0
check_cmd node || status=1
check_cmd pnpm || status=1
check_cmd forge || status=1
check_cmd nargo "$HOME/.nargo/bin/nargo" || status=1
check_cmd bb "$HOME/.bb/bb" || status=1

if [[ ! -d "contracts/lib/solady" ]]; then
  echo "[missing] contracts/lib/solady (run: pnpm contracts:deps)"
  status=1
else
  echo "[ok] contracts/lib/solady"
fi

if [[ $status -ne 0 ]]; then
  echo ""
  echo "One or more required tools are missing."
  echo "Install Noir toolchain (nargo/bb) via noirup: https://noir-lang.org/docs/getting_started/quick_start"
  exit 1
fi

echo ""
echo "Environment preflight passed."
