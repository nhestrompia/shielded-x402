# Testing Playbook

## 1) Baseline checks (always)

1. `pnpm install`
2. `pnpm doctor`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm contracts:test`
6. `pnpm circuit:check`
7. `pnpm circuit:verifier`
8. `pnpm circuit:fixture`

## 2) Package-level checks

### Shared types

- `pnpm --filter @shielded-x402/shared-types test`

### Client SDK

- `pnpm --filter @shielded-x402/client typecheck`
- `pnpm --filter @shielded-x402/client test`

### Merchant SDK

- `pnpm --filter @shielded-x402/merchant typecheck`
- `pnpm --filter @shielded-x402/merchant test`

### Payment relayer

- `pnpm --filter @shielded-x402/payment-relayer typecheck`
- `pnpm --filter @shielded-x402/payment-relayer test`

## 3) Sequencer + relayer behavior checks

Must pass properties:

- strict per-agent nonce progression (`agentNonce == nextAgentNonce`)
- no overspend (`balanceMicros` never negative)
- execution idempotency (`auth_id` unique, duplicate tx hash accepted, conflicting hash rejected)
- reclaim transition guard (`ISSUED -> RECLAIMED` only after expiry)
- relayer chainRef enforcement per instance

## 4) Local Anvil flow

1. Start chain:
   - `anvil --chain-id 31337`
2. Deploy local contracts:
   - `pnpm deploy:anvil:dummy`
3. Run smoke:
   - `pnpm e2e:anvil`

## 5) Sequencer/relayer integration checks

1. Start sequencer and relayer with chain-specific env.
2. Verify both `GET /health` endpoints.
3. Credit an agent via `POST /v1/admin/credit`.
4. Submit `POST /v1/credit/authorize`.
5. Execute `POST /v1/relay/pay`.
6. Confirm sequencer receives `POST /v1/credit/executions`.
7. Trigger `POST /v1/commitments/run`, then fetch `GET /v1/commitments/proof?authId=...`.

## 6) Solana integration checks

1. Build and test gateway program:
   - `pnpm solana:program:test`
2. Install Solana adapter dependencies:
   - `pnpm --dir chains/solana/client install`
3. Deploy verifier + gateway + initialize state/root:
   - `pnpm solana:deploy:verifier`
   - `pnpm solana:deploy:gateway`
   - `pnpm solana:init:gateway`
4. Validate relayer-side Solana adapter wiring and env:
   - `RELAYER_CHAIN_REF=solana:devnet`
   - `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_GATEWAY_PROGRAM_ID`, `SOLANA_VERIFIER_PROGRAM_ID`
   - `SOLANA_STATE_ACCOUNT`, `SOLANA_PAYER_KEYPAIR_PATH`
5. Run authorize -> relay pay -> execution report flow and confirm sequencer status is `EXECUTED`.
6. Run combined Base + Solana example:
   - `pnpm example:multi-chain:base-solana`

Indexer note:

- Solana indexer is optional for MVP correctness.
- Sequencer remains source of truth; relayers submit execution reports with tx signatures.
- Add a Solana indexer later for observability/reconciliation.

## 7) Base commitment registry checks

1. `forge test --root contracts --match-path test/CommitmentRegistryV1.t.sol`
2. Verify epoch sequencing and `prevRoot` linkage.
3. Verify unauthorized poster rejection.

## 8) Regression checklist before release

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm contracts:test`
4. `pnpm --filter @shielded-x402/payment-relayer test`
5. `pnpm --filter @shielded-x402/credit-sequencer test`
6. `pnpm --filter @shielded-x402/client test`
