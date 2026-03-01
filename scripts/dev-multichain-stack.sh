#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${X402_STACK_LOG_DIR:-$ROOT_DIR/.tmp/multichain-stack}"
PID_DIR="$LOG_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

SEQUENCER_LOG="$LOG_DIR/sequencer.log"
RELAYER_BASE_LOG="$LOG_DIR/relayer-base.log"
RELAYER_SOLANA_LOG="$LOG_DIR/relayer-solana.log"

SEQUENCER_PID_FILE="$PID_DIR/sequencer.pid"
RELAYER_BASE_PID_FILE="$PID_DIR/relayer-base.pid"
RELAYER_SOLANA_PID_FILE="$PID_DIR/relayer-solana.pid"

SEQUENCER_PORT="${SEQUENCER_PORT:-3200}"
RELAYER_BASE_PORT="${RELAYER_BASE_PORT:-3100}"
RELAYER_SOLANA_PORT="${RELAYER_SOLANA_PORT:-3101}"
RELAYER_BASE_CHAIN_REF="${RELAYER_BASE_CHAIN_REF:-eip155:8453}"
RELAYER_SOLANA_CHAIN_REF="${RELAYER_SOLANA_CHAIN_REF:-solana:devnet}"

SEQUENCER_DATABASE_URL="${SEQUENCER_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/x402}"
SEQUENCER_SIGNING_KEY_ID="${SEQUENCER_SIGNING_KEY_ID:-seq-key-1}"
SEQUENCER_SIGNING_PRIVATE_KEY="${SEQUENCER_SIGNING_PRIVATE_KEY:-0x3925bc98441ae12b8cd89c5f8b7b1b4ea052d758f8afec2850a6206ee9637876}"
SEQUENCER_PUBLIC_KEY="${SEQUENCER_PUBLIC_KEY:-0x1cbc9a3c8516865214e29e19405fcac0241c8482627f18d38631b643f8b2ce90}"
SEQUENCER_ADMIN_TOKEN="${SEQUENCER_ADMIN_TOKEN:-change-me}"
SEQUENCER_SUPPORTED_CHAIN_REFS="${SEQUENCER_SUPPORTED_CHAIN_REFS:-$RELAYER_BASE_CHAIN_REF,$RELAYER_SOLANA_CHAIN_REF}"

RELAYER_CALLER_AUTH_TOKEN="${RELAYER_CALLER_AUTH_TOKEN:-relay-secret}"
RELAYER_BASE_KEY_ID="${RELAYER_BASE_KEY_ID:-rel-base-1}"
RELAYER_BASE_PRIVATE_KEY="${RELAYER_BASE_PRIVATE_KEY:-0xb5f964641b76c242ad302ce4df1cddf9adcdfc94944d02c849a1ca375f0f2f84}"
RELAYER_BASE_PUBLIC_KEY="${RELAYER_BASE_PUBLIC_KEY:-0x99f7cdc94d5d25eed575580cb47b223cab2a1fc2493d6bd8a891b4122d289b7d}"
RELAYER_BASE_PAYOUT_MODE="${RELAYER_BASE_PAYOUT_MODE:-noop}"
RELAYER_SOLANA_KEY_ID="${RELAYER_SOLANA_KEY_ID:-rel-sol-1}"
RELAYER_SOLANA_PRIVATE_KEY="${RELAYER_SOLANA_PRIVATE_KEY:-0xe7381a1615943a0cf2c1cebf017fc6e0aeac87e4537bc5c2476d945bf7a1cad6}"
RELAYER_SOLANA_PUBLIC_KEY="${RELAYER_SOLANA_PUBLIC_KEY:-0x0e9567dfc1e1fccbd346ecbdb327ef281f698eae83b1412c548917ccff84f49e}"

DEFAULT_SEQUENCER_RELAYER_KEYS_JSON="{\"$RELAYER_BASE_CHAIN_REF\":{\"$RELAYER_BASE_KEY_ID\":\"$RELAYER_BASE_PUBLIC_KEY\"},\"$RELAYER_SOLANA_CHAIN_REF\":{\"$RELAYER_SOLANA_KEY_ID\":\"$RELAYER_SOLANA_PUBLIC_KEY\"}}"
DEFAULT_RELAYER_SEQUENCER_KEYS_JSON="{\"$SEQUENCER_SIGNING_KEY_ID\":\"$SEQUENCER_PUBLIC_KEY\"}"
SEQUENCER_RELAYER_KEYS_JSON="${SEQUENCER_RELAYER_KEYS_JSON:-$DEFAULT_SEQUENCER_RELAYER_KEYS_JSON}"
RELAYER_SEQUENCER_KEYS_JSON="${RELAYER_SEQUENCER_KEYS_JSON:-$DEFAULT_RELAYER_SEQUENCER_KEYS_JSON}"

is_valid_json() {
  local raw="$1"
  node -e "JSON.parse(process.argv[1])" "$raw" >/dev/null 2>&1
}

if ! is_valid_json "$SEQUENCER_RELAYER_KEYS_JSON"; then
  echo "[stack] warning: invalid SEQUENCER_RELAYER_KEYS_JSON, falling back to defaults"
  SEQUENCER_RELAYER_KEYS_JSON="$DEFAULT_SEQUENCER_RELAYER_KEYS_JSON"
fi

if ! is_valid_json "$RELAYER_SEQUENCER_KEYS_JSON"; then
  echo "[stack] warning: invalid RELAYER_SEQUENCER_KEYS_JSON, falling back to defaults"
  RELAYER_SEQUENCER_KEYS_JSON="$DEFAULT_RELAYER_SEQUENCER_KEYS_JSON"
fi

is_running() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

start_one() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  shift 3

  if is_running "$pid_file"; then
    echo "[$name] already running (pid $(cat "$pid_file"))"
    return
  fi

  (
    cd "$ROOT_DIR"
    "$@"
  ) >"$log_file" 2>&1 &
  echo $! >"$pid_file"
  echo "[$name] started pid $(cat "$pid_file") log=$log_file"
}

stop_one() {
  local name="$1"
  local pid_file="$2"
  if is_running "$pid_file"; then
    local pid
    pid="$(cat "$pid_file")"
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.5
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
    echo "[$name] stopped"
  else
    rm -f "$pid_file"
    echo "[$name] not running"
  fi
}

wait_http() {
  local name="$1"
  local url="$2"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[$name] ready: $url"
      return 0
    fi
    sleep 0.5
  done
  echo "[$name] did not become ready: $url"
  return 1
}

cmd_start() {
  start_one "sequencer" "$SEQUENCER_PID_FILE" "$SEQUENCER_LOG" env \
    SEQUENCER_PORT="$SEQUENCER_PORT" \
    SEQUENCER_DATABASE_URL="$SEQUENCER_DATABASE_URL" \
    SEQUENCER_SIGNING_KEY_ID="$SEQUENCER_SIGNING_KEY_ID" \
    SEQUENCER_SIGNING_PRIVATE_KEY="$SEQUENCER_SIGNING_PRIVATE_KEY" \
    SEQUENCER_ADMIN_TOKEN="$SEQUENCER_ADMIN_TOKEN" \
    SEQUENCER_SUPPORTED_CHAIN_REFS="$SEQUENCER_SUPPORTED_CHAIN_REFS" \
    SEQUENCER_RELAYER_KEYS_JSON="$SEQUENCER_RELAYER_KEYS_JSON" \
    pnpm sequencer:dev

  start_one "relayer-base" "$RELAYER_BASE_PID_FILE" "$RELAYER_BASE_LOG" env \
    RELAYER_PORT="$RELAYER_BASE_PORT" \
    RELAYER_CHAIN_REF="$RELAYER_BASE_CHAIN_REF" \
    RELAYER_SEQUENCER_URL="http://127.0.0.1:$SEQUENCER_PORT" \
    RELAYER_SEQUENCER_KEYS_JSON="$RELAYER_SEQUENCER_KEYS_JSON" \
    RELAYER_REPORTING_PRIVATE_KEY="$RELAYER_BASE_PRIVATE_KEY" \
    RELAYER_KEY_ID="$RELAYER_BASE_KEY_ID" \
    RELAYER_PAYOUT_MODE="$RELAYER_BASE_PAYOUT_MODE" \
    RELAYER_EVM_PRIVATE_KEY="${RELAYER_EVM_PRIVATE_KEY:-}" \
    RELAYER_CALLER_AUTH_TOKEN="$RELAYER_CALLER_AUTH_TOKEN" \
    pnpm relayer:dev

  start_one "relayer-solana" "$RELAYER_SOLANA_PID_FILE" "$RELAYER_SOLANA_LOG" env \
    RELAYER_PORT="$RELAYER_SOLANA_PORT" \
    RELAYER_CHAIN_REF="$RELAYER_SOLANA_CHAIN_REF" \
    RELAYER_SEQUENCER_URL="http://127.0.0.1:$SEQUENCER_PORT" \
    RELAYER_SEQUENCER_KEYS_JSON="$RELAYER_SEQUENCER_KEYS_JSON" \
    RELAYER_REPORTING_PRIVATE_KEY="$RELAYER_SOLANA_PRIVATE_KEY" \
    RELAYER_KEY_ID="$RELAYER_SOLANA_KEY_ID" \
    RELAYER_PAYOUT_MODE="solana" \
    RELAYER_CALLER_AUTH_TOKEN="$RELAYER_CALLER_AUTH_TOKEN" \
    pnpm relayer:dev

  wait_http "sequencer" "http://127.0.0.1:$SEQUENCER_PORT/health" || true
  wait_http "relayer-base" "http://127.0.0.1:$RELAYER_BASE_PORT/health" || true
  wait_http "relayer-solana" "http://127.0.0.1:$RELAYER_SOLANA_PORT/health" || true

  echo
  echo "Stack started."
  echo "Logs:"
  echo "  $SEQUENCER_LOG"
  echo "  $RELAYER_BASE_LOG"
  echo "  $RELAYER_SOLANA_LOG"
}

cmd_stop() {
  stop_one "relayer-solana" "$RELAYER_SOLANA_PID_FILE"
  stop_one "relayer-base" "$RELAYER_BASE_PID_FILE"
  stop_one "sequencer" "$SEQUENCER_PID_FILE"
}

cmd_status() {
  for svc in sequencer relayer-base relayer-solana; do
    case "$svc" in
      sequencer) pf="$SEQUENCER_PID_FILE" ;;
      relayer-base) pf="$RELAYER_BASE_PID_FILE" ;;
      relayer-solana) pf="$RELAYER_SOLANA_PID_FILE" ;;
    esac
    if is_running "$pf"; then
      echo "[$svc] running pid $(cat "$pf")"
    else
      echo "[$svc] stopped"
    fi
  done
}

cmd_logs() {
  tail -n 200 -f "$SEQUENCER_LOG" "$RELAYER_BASE_LOG" "$RELAYER_SOLANA_LOG"
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
