# x402 Solana Integration (MVP)

This directory contains the Solana integration path for the multi-chain credit MVP:

- `circuits/smt_exclusion`: Noir circuit used with Sunspot Groth16 verifier.
- `programs/x402_gateway`: native `solana-program` gateway that can CPI into the verifier and perform SOL settlement.
- `client/`: TypeScript adapter scaffold for relayer-side transaction submission.

## Scope

- Target chainRef: `solana:devnet`
- Asset: SOL
- Lifecycle parity (`close/challenge/finalize`) is intentionally out of scope for this MVP.

## References

This follows the Solana Foundation Noir example architecture (Noir + Sunspot + custom on-chain CPI path).

## Deploy + Init (Devnet)

Required env:

1. `SOLANA_DEPLOYER_KEYPAIR`
2. `SOLANA_CLUSTER=devnet`
3. `SOLANA_ADMIN_KEYPAIR_PATH` (for gateway init/root updates)
4. `GNARK_VERIFIER_BIN` (path to Sunspot verifier-bin crate, required by `sunspot deploy`)

Run:

```bash
pnpm --dir chains/solana/client install
pnpm solana:deploy:verifier
pnpm solana:deploy:gateway

# set SOLANA_GATEWAY_PROGRAM_ID from deploy output first
pnpm solana:init:gateway
```

`solana:init:gateway` derives the state PDA automatically (or uses `SOLANA_STATE_ACCOUNT` if provided) and sets the SMT root from:

1. `SOLANA_SMT_ROOT_HEX`, or
2. `SOLANA_PUBLIC_WITNESS_PATH` (defaults to `chains/solana/circuits/smt_exclusion/target/smt_exclusion.pw`)

## Test Commands

1. Adapter encoding tests: `pnpm solana:adapter:test`
2. Gateway rust tests: `pnpm solana:program:test`
3. Dual-chain example: `pnpm example:multi-chain:base-solana`

## Runtime integration notes

1. Solana relayer uses `RELAYER_PAYOUT_MODE=solana` and reports real tx signatures as `executionTxHash`.
2. For local full-flow testing, Base can run in `noop` while Solana runs onchain.
3. No Solana indexer is required for MVP correctness; indexers are optional for analytics/monitoring.
