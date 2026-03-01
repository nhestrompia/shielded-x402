# Quickstart (Multi-Chain Credit MVP)

1. Start sequencer and relayers (Base + Solana instances) with v1 env vars.
2. Seed balances via `POST /v1/admin/credit`.
3. Authorize payment via `POST /v1/credit/authorize`.
4. Execute payment via `POST /v1/relay/pay` on the chain-specific relayer.
5. Fetch delayed proof material via `GET /v1/commitments/proof?authId=...`.

Full protocol spec: [`docs/multi-chain-credit-mvp.md`](./multi-chain-credit-mvp.md)
