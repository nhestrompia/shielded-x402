# SMT Exclusion Circuit (Solana)

MVP circuit proving a payer is not blacklisted for the Solana gateway flow.

This circuit is intentionally aligned with the Noir + Sunspot workflow used in Solana examples:

1. `nargo compile`
2. `nargo execute`
3. `sunspot compile/setup/prove`
4. `sunspot deploy` to generate verifier program
5. Gateway program performs CPI into verifier program during `PayAuthorized`

For MVP this directory is the integration anchor; prover artifacts are generated per deployment environment.

## Typical workflow from repo root

1. `pnpm solana:deploy:verifier`
2. `pnpm solana:deploy:gateway`
3. `pnpm solana:init:gateway`

Generated proof and witness defaults used by the relayer example:

1. `chains/solana/circuits/smt_exclusion/target/smt_exclusion.proof`
2. `chains/solana/circuits/smt_exclusion/target/smt_exclusion.pw`
