import { concatHex, keccak256, pad, type Hex } from 'viem';
const CHALLENGE_DOMAIN_HASH = '0xe32e24a51c351093d339c0035177dc2da5c1b8b9563e414393edd75506dcc055' as Hex;

export function deriveCommitment(amount: bigint, rho: Hex, pkHash: Hex): Hex {
  const amountWord = (`0x${amount.toString(16).padStart(64, '0')}` as Hex);
  return keccak256(concatHex([amountWord, rho, pkHash]));
}

export function deriveNullifier(nullifierSecret: Hex, commitment: Hex): Hex {
  return keccak256(concatHex([nullifierSecret, commitment]));
}

export function deriveChallengeHash(challengeNonce: Hex, amount: bigint, merchant: Hex): Hex {
  const amountWord = (`0x${amount.toString(16).padStart(64, '0')}` as Hex);
  const merchantWord = pad(merchant, { size: 32 });
  return keccak256(concatHex([CHALLENGE_DOMAIN_HASH, challengeNonce, amountWord, merchantWord]));
}
