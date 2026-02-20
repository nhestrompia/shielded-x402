# Agent Integration Guide (Shielded x402)

This guide describes the current production path: credit-channel payments.

## Core Model

1. Agent holds shielded notes locally.
2. Agent sends one proof-backed topup to relayer.
3. Agent sends signature-only debit intents per paid call.
4. Agent persists the returned co-signed state each time.

## Required Relayer Endpoints

- `POST /v1/relay/credit/domain`
- `POST /v1/relay/credit/topup`
- `POST /v1/relay/credit/pay`
- `POST /v1/relay/credit/close/start`
- `POST /v1/relay/credit/close/challenge`
- `POST /v1/relay/credit/close/finalize`
- `GET /v1/relay/credit/close/:channelId`

## Required Headers / Wire

Merchant challenge/accept path remains x402-style:

- `PAYMENT-REQUIRED` on `402`
- `PAYMENT-SIGNATURE` for signed payment envelope payloads

Use constants and parsers from `@shielded-x402/shared-types`.

## Fast Path (Per Call)

For each request:

1. Request merchant endpoint.
2. If status is not `402`, return response.
3. Parse requirement.
4. Build debit intent against latest signed state.
5. Call `/v1/relay/credit/pay`.
6. Persist returned next state.

Rules enforced:

- strict sequencing (`nextSeq = currentSeq + 1`)
- request idempotency via `requestId`
- debit bound to canonical `merchantRequestHash`

## Topup Path

Topup is required before fast debits if no channel state exists.

1. Select a spendable note.
2. Build proof-backed shielded payment payload.
3. Submit `/v1/relay/credit/topup`.
4. Persist returned signed state.
5. Mark input note spent and persist change note.

## Trust Model

Credit mode is optimistic offchain state progression while channel is open.

- Relayer has custody/trust assumptions for prepaid balance.
- Close/challenge/finalize provides onchain dispute/settlement path.

## SDK Integration Pattern

Use `@shielded-x402/client` primitives:

- `createCreditChannelClient`
- `createCreditShieldedFetch`
- `createCreditCloseClient`
- `FileBackedWalletState`

For discovery/routing:

- `createAgentPaymentFetch` with ERC-8004 directory providers.

## ERC-8004 Discovery (Optional)

Discovery determines *where* to call, not settlement correctness.

1. Resolve profile from directory providers.
2. Select endpoint deterministically.
3. Execute credit payment fetch on selected URL.

If directory is unavailable, direct URL mode still works.

## Operational Checklist

1. Persist wallet state to durable storage.
2. Keep `requestId` unique per debit.
3. Keep relayer domain (`chainId`, `verifyingContract`) consistent.
4. Run periodic `wallet.sync()` to keep witness/leaf data current.
5. Treat concurrent debits per channel as sequential (SDK already queues per client instance).

## Test Checklist

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm contracts:test`
4. Relayer tests:
   - `pnpm --filter @shielded-x402/payment-relayer test`
5. Example smoke runs:
   - `examples/agent-to-agent-relayed`
   - `examples/payai-shielded-relay`
