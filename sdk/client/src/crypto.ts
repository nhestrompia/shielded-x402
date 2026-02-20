import {
  challengeHashPreimage,
  toHexWord,
  type Hex
} from '@shielded-x402/shared-types';
import { concatHex, keccak256 } from 'viem';

export function deriveCommitment(amount: bigint, rho: Hex, pkHash: Hex): Hex {
  return keccak256(concatHex([toHexWord(amount), rho, pkHash]));
}

export function deriveNullifier(nullifierSecret: Hex, commitment: Hex): Hex {
  return keccak256(concatHex([nullifierSecret, commitment]));
}

export function deriveChallengeHash(challengeNonce: Hex, amount: bigint, merchant: Hex): Hex {
  return keccak256(concatHex(challengeHashPreimage(challengeNonce, amount, merchant)));
}
