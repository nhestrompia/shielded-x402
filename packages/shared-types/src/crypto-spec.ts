export const CRYPTO_SPEC = {
  version: 'v0.1.0',
  hashFunction: 'keccak256',
  merkleTreeDepth: 32,
  noteEncoding: 'abi-packed-v1',
  nullifierDerivation: 'keccak256(nullifierSecret, noteCommitment)',
  merchantCommitmentDerivation: 'keccak256(payAmount, merchantRho, merchantPkHash)',
  changeCommitmentDerivation: 'keccak256(changeAmount, changeRho, changePkHash)',
  challengeDomainSeparator: 'shielded-x402:v1:challenge',
  commitmentDomainSeparator: 'shielded-x402:v1:commitment',
  outputDomainSeparator: 'shielded-x402:v1:output',
  nullifierDomainSeparator: 'shielded-x402:v1:nullifier'
} as const;

export type CryptoSpec = typeof CRYPTO_SPEC;
