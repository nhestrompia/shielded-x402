# Payment Relayer

Runs the no-merchant-change flow:

1. receive agent-generated shielded proof bundle
2. verify challenge/proof bindings
3. settle onchain via `ShieldedPool.submitSpend`
4. execute merchant payout adapter

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
- `RELAYER_PAYOUT_MODE=forward|noop`
- `RELAYER_PAYOUT_HEADERS_JSON` (JSON map, used by `forward` mode)

## Endpoints

- `GET /health`
- `POST /v1/relay/pay`
- `GET /v1/relay/status/:settlementId`
