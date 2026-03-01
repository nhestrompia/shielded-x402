# SDK

The SDK surface is now centered on `MultiChainCreditClient` and sequencer/relayer v1 routes:

- `POST /v1/credit/authorize`
- `POST /v1/relay/pay`
- `POST /v1/credit/executions` (relayer->sequencer)
- `POST /v1/credit/reclaim`
- `GET /v1/commitments/latest`
- `GET /v1/commitments/proof`

Legacy `/v1/relay/credit/*` client helpers are intentionally removed.

Protocol details: [`docs/multi-chain-credit-mvp.md`](./multi-chain-credit-mvp.md)
