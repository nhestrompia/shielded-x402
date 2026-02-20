# Payment Relayer

Runs the credit-channel relay flow:

1. accept proof-backed credit topups
2. verify co-signed credit states and debit intents
3. execute merchant payout adapter on each debit
4. return the next relayer-signed state
5. optionally settle close/challenge/finalize onchain

## Run

```bash
pnpm relayer:dev
```

## Env

- `RELAYER_PORT` (default `3100`)
- `RELAYER_RPC_URL` (or `SEPOLIA_RPC_URL`)
- `SHIELDED_POOL_ADDRESS`
- `RELAYER_VERIFYING_CONTRACT` (preferred) or `PAYMENT_VERIFYING_CONTRACT` or `ULTRA_VERIFIER_ADDRESS`
- `RELAYER_PRIVATE_KEY` (or `PAYMENT_RELAYER_PRIVATE_KEY`)
- `RELAYER_PAYOUT_MODE=forward|noop|x402`
- `RELAYER_PAYOUT_HEADERS_JSON` (JSON map, used by `forward` mode)
- `RELAYER_SHIELDED_VERIFYING_CONTRACT` (fallback verifying contract; defaults to `SHIELDED_POOL_ADDRESS`)
- `RELAYER_X402_RPC_URL` (required for `x402` mode; or use `BASE_SEPOLIA_RPC_URL`)
- `RELAYER_X402_PRIVATE_KEY` (required for `x402` mode; fallback to `RELAYER_PRIVATE_KEY`)
- `RELAYER_X402_CHAIN=base-sepolia|sepolia` (default `base-sepolia`)
- `RELAYER_CHAIN_ID` (required by credit EIP-712 domain; must match relayer chain)
- `RELAYER_CREDIT_HEAD_STORE_PATH` (default `/tmp/shielded-x402-credit-heads.json`; persisted channel heads for restart safety)
- `CREDIT_SETTLEMENT_CONTRACT` (optional, enables Phase 2 onchain close/challenge/finalize)
- `CREDIT_SETTLEMENT_RPC_URL` (optional, defaults to `RELAYER_RPC_URL`)

`x402` payout mode uses `x402-fetch` internally so relayer can pay upstream standard x402 endpoints after shielded settlement.

Verifier address note:
- For this relayer verification path, point the verifier env var to the `NoirVerifierAdapter` contract (the compact public-input verifier interface), not the raw generated Ultra/Honk verifier unless you also provide expanded 161 public inputs.

## Endpoints

- `GET /health`
- `POST /v1/relay/credit/domain`
- `POST /v1/relay/credit/topup`
- `POST /v1/relay/credit/pay`
- `POST /v1/relay/credit/close/start`
- `POST /v1/relay/credit/close/challenge`
- `POST /v1/relay/credit/close/finalize`
- `GET /v1/relay/credit/close/:channelId`

## Credit Deployment Notes

- Credit channels are strictly sequential (`nextSeq = currentSeq + 1`) per `channelId`.
- The relayer lock is process-local; deploy as a single relayer instance unless you add a distributed lock.
- Persist `RELAYER_CREDIT_HEAD_STORE_PATH` on durable storage so stale client states are rejected after restart.
