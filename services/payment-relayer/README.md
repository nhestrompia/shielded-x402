# Payment Relayer

Runs the no-merchant-change flow:

1. receive agent-generated shielded proof bundle
2. issue shielded challenge bridge for standard x402 merchants
3. verify challenge/proof bindings
4. settle onchain via `ShieldedPool.submitSpend`
5. execute merchant payout adapter

## Run

```bash
pnpm relayer:dev
```

## Env

- `RELAYER_PORT` (default `3100`)
- `RELAYER_RPC_URL` (or `SEPOLIA_RPC_URL`)
- `SHIELDED_POOL_ADDRESS`
- `ULTRA_VERIFIER_ADDRESS`
- `RELAYER_PRIVATE_KEY` (or `PAYMENT_RELAYER_PRIVATE_KEY`)
- `RELAYER_STORE_PATH` (default `/tmp/shielded-x402-relayer-store.json`)
- `RELAYER_PAYOUT_MODE=forward|noop|x402`
- `RELAYER_PAYOUT_HEADERS_JSON` (JSON map, used by `forward` mode)
- `RELAYER_CHALLENGE_TTL_MS` (default `180000`)
- `RELAYER_SHIELDED_MERCHANT_PUBKEY` (bridge-issued shielded merchant pubkey)
- `RELAYER_SHIELDED_VERIFYING_CONTRACT` (bridge-issued verifying contract; defaults to `SHIELDED_POOL_ADDRESS`)
- `RELAYER_X402_RPC_URL` (required for `x402` mode; or use `BASE_SEPOLIA_RPC_URL`)
- `RELAYER_X402_PRIVATE_KEY` (required for `x402` mode; fallback to `RELAYER_PRIVATE_KEY`)
- `RELAYER_X402_CHAIN=base-sepolia|sepolia` (default `base-sepolia`)

`x402` payout mode uses `x402-fetch` internally so relayer can pay upstream standard x402 endpoints after shielded settlement.

## Endpoints

- `GET /health`
- `POST /v1/relay/challenge`
- `POST /v1/relay/pay`
- `GET /v1/relay/status/:settlementId`
