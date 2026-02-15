import { CRYPTO_SPEC } from '@shielded-x402/shared-types';
import { concatHex, keccak256, pad, type Hex } from 'viem';

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
  return keccak256(
    concatHex([CRYPTO_SPEC.challengeDomainHash as Hex, challengeNonce, amountWord, merchantWord])
  );
}
