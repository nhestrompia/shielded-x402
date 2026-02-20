# Shielded x402 Architecture

## Components

- `contracts/`: `ShieldedPool`, verifier adapters, `CreditChannelSettlement`.
- `circuits/spend_change/`: Noir spend/change circuit.
- `sdk/client/`: proof payload building, credit client/fetch, wallet state, A2A routing.
- `sdk/merchant/`: challenge issuance + payload verification utilities.
- `services/payment-relayer/`: credit topup/pay/close APIs + payout adapters.
- `packages/shared-types/`: canonical types, hashes, route constants.
- `packages/erc8004-adapter/`: discovery providers and canonical profile normalization.

## Primary Flow (Credit Lane)

1. Merchant returns `402` with `PAYMENT-REQUIRED`.
2. Agent ensures channel has credit:
   - if missing/insufficient: proof-backed topup via `/v1/relay/credit/topup`.
3. Agent sends signed debit intent via `/v1/relay/credit/pay`.
4. Relayer validates state/debit, executes payout adapter call, and returns next signed state.
5. Agent persists next signed state.

## Safety Controls

- sequential channel rule (`nextSeq = currentSeq + 1`)
- debit intent binds to `merchantRequestHash`
- per-channel relayer lock + head compare-and-swap
- persisted head store for restart safety
- mandatory `requestId` for idempotency

## Close / Dispute Path

When enabled (`CREDIT_SETTLEMENT_CONTRACT`):

- `POST /v1/relay/credit/close/start`
- `POST /v1/relay/credit/close/challenge`
- `POST /v1/relay/credit/close/finalize`
- `GET /v1/relay/credit/close/:channelId`

## Discovery Boundary

- ERC-8004 discovery runs in SDK (endpoint selection only).
- Settlement correctness remains cryptographic and relayer/onchain enforced.

## Sequence

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent SDK
  participant M as Merchant API
  participant R as Payment Relayer
  participant P as ShieldedPool

  A->>M: Request paid resource
  M-->>A: 402 + PAYMENT-REQUIRED

  alt credit missing or insufficient
    A->>A: Build proof-backed payment payload
    A->>R: POST /v1/relay/credit/topup
    R->>P: settle onchain
    R-->>A: next signed credit state
  end

  A->>R: POST /v1/relay/credit/pay
  R->>R: validate latest state + debit intent
  R->>M: execute payout adapter request
  M-->>R: merchant response
  R-->>A: merchant response + next signed state
```
