# Payment Relayer Architecture

## Goal

Provide a fast credit payment lane for x402 requests:

1. proof-backed topup
2. signature-only debit per paid call
3. optional onchain close/challenge/finalize settlement

## Relayer Responsibilities

- verify topup payload validity (shape, nullifier/proof checks, settlement)
- verify debit intent validity (state signatures, seq, balance, deadline, hash binding)
- execute payout adapter call
- sign and return next channel state

## Request Lifecycle

1. `POST /v1/relay/credit/topup`
2. relayer settles topup and returns next signed state
3. `POST /v1/relay/credit/pay`
4. relayer validates + pays merchant + returns next signed state

## Safety Controls

- strict sequencing: `nextSeq = currentSeq + 1`
- per-channel lock for concurrent requests
- state-head compare-and-swap to reject stale state
- persisted head store (`RELAYER_CREDIT_HEAD_STORE_PATH`)
- idempotency via `requestId`

## Payout Modes

- `forward`: plain forwarding with optional static headers
- `noop`: local/dev success stub
- `x402`: relayer pays upstream x402 endpoints via `x402-fetch`

## Environment Highlights

- `RELAYER_RPC_URL` / `SEPOLIA_RPC_URL`
- `SHIELDED_POOL_ADDRESS`
- `RELAYER_PRIVATE_KEY`
- `RELAYER_CHAIN_ID`
- `RELAYER_PAYOUT_MODE=forward|noop|x402`
- `RELAYER_PAYOUT_HEADERS_JSON`
- `RELAYER_X402_RPC_URL`
- `RELAYER_X402_PRIVATE_KEY`
- `RELAYER_X402_CHAIN=base-sepolia|sepolia`
- `RELAYER_CREDIT_HEAD_STORE_PATH`
- `CREDIT_SETTLEMENT_CONTRACT`
- `CREDIT_SETTLEMENT_RPC_URL`

## Endpoints

- `GET /health`
- `POST /v1/relay/credit/domain`
- `POST /v1/relay/credit/topup`
- `POST /v1/relay/credit/pay`
- `POST /v1/relay/credit/close/start`
- `POST /v1/relay/credit/close/challenge`
- `POST /v1/relay/credit/close/finalize`
- `GET /v1/relay/credit/close/:channelId`

## Operational Constraints

- lock implementation is process-local (single instance unless you add distributed locking)
- idempotency caches are in-memory (best-effort across restarts)
