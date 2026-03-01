# Architecture

## Runtime split

1. Sequencer (`services/credit-sequencer`)
   - authoritative nonce/balance ledger
   - signed authorizations
   - reclaim + execution recording
   - hourly commitment root batches
2. Relayer (`services/payment-relayer`)
   - verifies sequencer signatures
   - executes chain-specific payment action
   - posts signed execution reports back to sequencer
3. Base Commitment Registry (`contracts/src/CommitmentRegistryV1.sol`)
   - delayed audit checkpoints only

## Solana path

- Noir `smt_exclusion` circuit + Sunspot verifier
- native Solana gateway CPI to verifier and SOL transfer
- relayer reports confirmed tx signature as `executionTxHash`

Protocol and data model: [`docs/multi-chain-credit-mvp.md`](./multi-chain-credit-mvp.md)
