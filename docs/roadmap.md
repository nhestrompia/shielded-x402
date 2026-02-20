# Delivery Roadmap

## v0.3 (implemented)

- Credit-channel-first settlement flow.
- One proof-backed topup (`POST /v1/relay/credit/topup`) then signature-only debit (`POST /v1/relay/credit/pay`).
- Co-signed `CreditState` with strict sequential enforcement (`nextSeq = currentSeq + 1`).
- Canonical merchant request hashing and typed-data signing shared across SDK and relayer.
- Relayer per-channel locking, state-head CAS checks, persisted head store.
- SDK credit clients (`createCreditChannelClient`, `createCreditShieldedFetch`, `createCreditCloseClient`) and durable `FileBackedWalletState` v3.
- ERC-8004 discovery integrated into agent routing (`createAgentPaymentFetch`).

## v0.4 (implemented)

- Credit close/challenge/finalize routes and onchain settlement contract support:
  - `POST /v1/relay/credit/close/start`
  - `POST /v1/relay/credit/close/challenge`
  - `POST /v1/relay/credit/close/finalize`
  - `GET /v1/relay/credit/close/:channelId`
- `CreditChannelSettlement` contract + Foundry tests.
- End-to-end example coverage for:
  - Agent-to-agent relayed credit flow.
  - PayAI upstream x402 payout via relayer `x402` mode.

## Next priorities

- Persist idempotency replay caches for stronger restart semantics.
- Distributed channel locking for multi-instance relayer deployments.
- Additional hardening tests for rejection paths and restart edge cases.
- Documentation polish and narrower quickstart profiles by environment (local/anvil/sepolia).
