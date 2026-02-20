import type { Hex } from './types.js';
import { CRYPTO_SPEC } from './crypto-spec.js';

export function toHexWord(value: bigint | number | string): Hex {
  const normalized =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number'
        ? BigInt(value)
        : BigInt(value);
  if (normalized < 0n) {
    throw new Error('toHexWord expects a non-negative value');
  }
  return (`0x${normalized.toString(16).padStart(64, '0')}`) as Hex;
}

export function padAddressToWord(address: Hex): Hex {
  const stripped = address.toLowerCase().replace(/^0x/, '');
  if (stripped.length > 40) {
    throw new Error('address exceeds 20 bytes');
  }
  return (`0x${stripped.padStart(64, '0')}`) as Hex;
}

export function challengeHashPreimage(challengeNonce: Hex, amount: bigint, merchant: Hex): [
  Hex,
  Hex,
  Hex,
  Hex
] {
  return [
    CRYPTO_SPEC.challengeDomainHash as Hex,
    challengeNonce,
    toHexWord(amount),
    padAddressToWord(merchant)
  ];
}
