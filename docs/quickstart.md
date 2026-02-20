# Quickstart

## 1) Install + baseline validation

- `pnpm install`
- `pnpm contracts:deps`
- `pnpm doctor`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm contracts:test`

## 2) Circuit + verifier artifacts

- `pnpm circuit:check`
- `pnpm circuit:verifier`
- `pnpm circuit:fixture`

Outputs:

- `contracts/generated/UltraVerifier.sol`
- `sdk/client/src/circuits/spend_change.json`
- `ops/fixtures/sepolia-payment-response.json`

## 3) Run payment relayer

```bash
pnpm relayer:dev
```

Required env (minimum):

- `RELAYER_RPC_URL` (or `SEPOLIA_RPC_URL`)
- `SHIELDED_POOL_ADDRESS`
- `RELAYER_VERIFYING_CONTRACT` (NoirVerifierAdapter address)
- `RELAYER_PRIVATE_KEY`
- `RELAYER_CHAIN_ID`
- `RELAYER_UNSAFE_DEV_MODE=false`

Common optional env:

- `RELAYER_PAYOUT_MODE=forward|noop|x402`
- `RELAYER_PAYOUT_HEADERS_JSON='{"authorization":"Bearer ..."}'`
- `RELAYER_CREDIT_HEAD_STORE_PATH=/path/to/credit-heads.json`
- `CREDIT_SETTLEMENT_CONTRACT` + `CREDIT_SETTLEMENT_RPC_URL`

`RELAYER_UNSAFE_DEV_MODE=true` is only for local insecure testing.

## 4) Prepare agent wallet state

Create wallet state and seed at least one spendable note.

Reference scripts:

- `examples/agent-to-agent-relayed/seed-note.mjs`
- `examples/agent-to-agent-relayed/test-agent-payment.mjs`

## 5) Run credit flow example

Agent-to-agent relayed example:

```bash
cd examples/agent-to-agent-relayed
npm install
cp .env.example .env
npm run seed-note
npm run start
```

What it does:

1. resolves a payable target URL (direct or ERC-8004),
2. bootstraps channel credit with one proof-backed topup if needed,
3. performs paid calls via signature-only debit (`/v1/relay/credit/pay`).

ERC-8004 adapter env for this example (optional):

- `ERC8004_ENVIO_GRAPHQL_URL`
- `ERC8004_REGISTRY_ADDRESS` + `ERC8004_RPC_URL` + `ERC8004_CHAIN_ID`
- `ERC8004_SCAN_API_URL`

## 6) Optional PayAI credit example

```bash
cd examples/payai-shielded-relay
npm install
cp .env.example .env
npm run seed-note
npm run start
```

This validates relayer `x402` payout mode against a standard upstream x402 endpoint.

## 7) Optional onchain channel close flow

If `CREDIT_SETTLEMENT_CONTRACT` is configured:

- `POST /v1/relay/credit/close/start`
- `POST /v1/relay/credit/close/challenge`
- `POST /v1/relay/credit/close/finalize`

## 8) Local Anvil smoke

- `anvil --chain-id 31337`
- `pnpm deploy:anvil:dummy`
- `pnpm e2e:anvil`

For deeper command sequences, see `docs/testing-playbook.md`.
