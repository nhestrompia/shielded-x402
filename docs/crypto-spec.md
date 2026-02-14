# Cryptographic Parameter Freeze (MVP)

Canonical source of truth: `packages/shared-types/src/crypto-spec.ts`

- Hash primitive: `keccak256`
- Merkle tree depth: `32`
- Note encoding: `abi-packed-v1`
- Nullifier derivation: `keccak256(nullifierSecret, noteCommitment)`
- Output commitments:
  - merchant: `keccak256(payAmount, merchantRho, merchantPkHash)`
  - change: `keccak256(changeAmount, changeRho, changePkHash)`
- Domain separators:
  - challenge: `shielded-x402:v1:challenge`
  - commitment: `shielded-x402:v1:commitment`
  - output: `shielded-x402:v1:output`
  - nullifier: `shielded-x402:v1:nullifier`
