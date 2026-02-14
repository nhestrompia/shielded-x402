import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { CRYPTO_SPEC } from '@shielded-x402/shared-types';
import { deriveWitness, emptyRoot } from './merkle.js';

describe('merkle witness derivation', () => {
  it('returns empty-root based tree witness shape', () => {
    const commitments = [keccak256(toHex('a'))];
    const witness = deriveWitness(commitments, 0);

    expect(witness.path).toHaveLength(CRYPTO_SPEC.merkleTreeDepth);
    expect(witness.indexBits).toHaveLength(CRYPTO_SPEC.merkleTreeDepth);
    expect(witness.root.startsWith('0x')).toBe(true);
    expect(witness.root).not.toBe(emptyRoot());
  });

  it('derives different roots for different commitment sets', () => {
    const c1 = keccak256(toHex('c1'));
    const c2 = keccak256(toHex('c2'));
    const one = deriveWitness([c1], 0).root;
    const two = deriveWitness([c1, c2], 0).root;
    expect(one).not.toBe(two);
  });
});
