# spend_change circuit

This directory contains the Noir circuit for one-note spend with merchant + change outputs.

## Current state

- Uses Noir `keccak256` library (`dep::keccak256::keccak256`) for commitment, nullifier, Merkle-path, and challenge binding constraints.
- Uses independent output randomness for merchant and change commitments (`merchant_rho`, `change_rho`), so outputs are not linkable via input note randomness.
- Public outputs mirror contract verifier inputs:
  - `root`
  - `nullifier`
  - `merchantCommitment`
  - `changeCommitment`
  - `challengeHash`
  - `amount`
- Merkle path input is byte-accurate (`[[u8; 32]; 24]`) to avoid Field-modulus loss for hash values.

## Commands

- `nargo check`
- `nargo execute witness`
- `pnpm circuit:verifier`
- `pnpm circuit:fixture`
