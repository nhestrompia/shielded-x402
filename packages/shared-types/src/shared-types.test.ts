import { describe, expect, it } from 'vitest';
import { CRYPTO_SPEC } from './crypto-spec.js';

describe('CRYPTO_SPEC', () => {
  it('locks expected tree depth', () => {
    expect(CRYPTO_SPEC.merkleTreeDepth).toBe(32);
  });
});
