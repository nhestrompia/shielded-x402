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

## 3) Credit-relayer behavior tests

Run focused suites:

- `pnpm --filter @shielded-x402/payment-relayer test -- creditProcessor.test.ts`
- `pnpm --filter @shielded-x402/payment-relayer test -- payout.test.ts`

Must pass properties:

- strict seq progression (`nextSeq = currentSeq + 1`)
- per-channel concurrency lock behavior
- stale state rejection
- request idempotency behavior
- payload shape + signature validation

## 4) Local Anvil flow

1. Start chain:
   - `anvil --chain-id 31337`
2. Deploy local contracts:
   - `pnpm deploy:anvil:dummy`
3. Run smoke:
   - `pnpm e2e:anvil`

## 5) Relayer integration checks

1. Start relayer with env for your target chain.
2. Verify `GET /health` shows expected mode/domain values.
3. Execute one topup request (`/v1/relay/credit/topup`).
4. Execute multiple debit requests (`/v1/relay/credit/pay`).
5. Confirm state persistence survives relayer restart (head store path).

## 6) Example-level end-to-end checks

### Agent-to-agent relayed

```bash
cd examples/agent-to-agent-relayed
npm install
cp .env.example .env
npm run seed-note
npm run start
```

Expected:

- topup occurs only when channel state is missing/insufficient,
- paid calls use signature-only debit path,
- wallet state is updated after each call.

### PayAI shielded relay

```bash
cd examples/payai-shielded-relay
npm install
cp .env.example .env
npm run seed-note
npm run start
```

Expected:

- relayer `x402` payout adapter pays upstream merchant endpoint,
- local channel state progresses normally.

## 7) Onchain close/challenge/finalize (optional)

If `CREDIT_SETTLEMENT_CONTRACT` is configured:

1. Start close with latest signed state.
2. Challenge with higher state if needed.
3. Finalize after challenge period.
4. Validate paid-to-agent/paid-to-relayer outputs.

## 8) Regression checklist before release

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm contracts:test`
4. `pnpm --filter @shielded-x402/payment-relayer test`
5. `pnpm --filter @shielded-x402/client test`
6. At least one full example run (`agent-to-agent-relayed` or `payai-shielded-relay`).
