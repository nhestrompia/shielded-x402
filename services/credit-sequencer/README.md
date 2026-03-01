# Credit Sequencer (MVP)

Authoritative sequencer for multi-chain credit authorization.

Responsibilities:

1. enforce per-agent nonce/balance invariants in real time
2. issue signed `AuthorizationV1` payloads
3. process relayer execution reports with idempotency checks
4. handle reclaim transitions for expired issued authorizations
5. build periodic commitment epochs and optional Base postings

## Run

```bash
pnpm --filter @shielded-x402/credit-sequencer migrate:up
pnpm sequencer:dev
```

## Integration Tests

- Set `SEQUENCER_TEST_DATABASE_URL` to run Postgres-backed sequencer/relayer integration tests.
- Without it, integration tests are skipped.

## Required Env

- `SEQUENCER_DATABASE_URL`
- `SEQUENCER_SIGNING_PRIVATE_KEY` (32-byte seed or 64-byte secret key hex)

## Recommended Env

- `SEQUENCER_SIGNING_KEY_ID` (default `seq-key-1`)
- `SEQUENCER_LEAF_SALT_SECRET` (32-byte hex)
- `SEQUENCER_SUPPORTED_CHAIN_REFS` (comma-separated, example `eip155:84532,solana:devnet`)
- `SEQUENCER_EPOCH_SECONDS` (default `3600`)
- `SEQUENCER_EXECUTION_GRACE_SECONDS` (default `300`)
- `SEQUENCER_SWEEPER_SECONDS` (default `30`)
- `SEQUENCER_ADMIN_TOKEN`
- `SEQUENCER_RELAYER_KEYS_JSON` (optional bootstrap map:
  `{ \"solana:devnet\": {\"rel-sol-1\": \"0x<ed25519-pubkey>\"}, \"eip155:84532\": {\"rel-base-1\": \"0x<ed25519-pubkey>\"} }`)

## Optional Base Commitment Posting

- `SEQUENCER_BASE_REGISTRY_ADDRESS`
- `SEQUENCER_BASE_POSTER_PRIVATE_KEY`
- `SEQUENCER_BASE_RPC_URL`

## API

- `GET /health`
- `GET /health/ready`
- `GET /metrics`
- `POST /v1/admin/credit`
- `POST /v1/credit/authorize`
- `POST /v1/credit/executions`
- `POST /v1/credit/reclaim`
- `GET /v1/commitments/latest`
- `GET /v1/commitments/proof?authId=...`
- `POST /v1/commitments/run`

## Notes

1. Execution correctness is enforced at authorization/report time by sequencer state transitions.
2. Base commitment roots are audit checkpoints and do not gate relayer execution in MVP.
