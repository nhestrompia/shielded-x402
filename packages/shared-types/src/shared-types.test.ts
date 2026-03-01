import { describe, expect, it } from 'vitest';
import { CRYPTO_SPEC } from './crypto-spec.js';
import { challengeHashPreimage, toHexWord } from './crypto.js';
import { normalizeHex } from './hex.js';
import { validateShieldedPaymentResponseShape } from './shielded.js';

describe('CRYPTO_SPEC', () => {
  it('locks expected tree depth', () => {
    expect(CRYPTO_SPEC.merkleTreeDepth).toBe(24);
  });
});

describe('shared crypto helpers', () => {
  it('toHexWord encodes 32-byte words', () => {
    expect(toHexWord(10n)).toBe('0x000000000000000000000000000000000000000000000000000000000000000a');
  });

  it('builds challenge hash preimage components deterministically', () => {
    const preimageA = challengeHashPreimage(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      10000n,
      '0x0000000000000000000000000000000000000002'
    );
    const preimageB = challengeHashPreimage(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      10000n,
      '0x0000000000000000000000000000000000000002'
    );
    expect(preimageA).toEqual(preimageB);
    expect(preimageA[2]).toBe('0x0000000000000000000000000000000000000000000000000000000000002710');
    expect(preimageA[3]).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('normalizes hex without numeric reinterpretation', () => {
    expect(normalizeHex('42')).toBe('0x42');
    expect(normalizeHex('0X2A')).toBe('0x2a');
  });
});

describe('shielded payload validation', () => {
  it('accepts valid 6-input payload shape', () => {
    const payload = {
      proof: '0x12',
      publicInputs: [
        '0x01',
        '0x02',
        '0x03',
        '0x04',
        '0x05',
        '0x06'
      ],
      nullifier: '0x' + '11'.repeat(32),
      root: '0x' + '22'.repeat(32),
      merchantCommitment: '0x' + '33'.repeat(32),
      changeCommitment: '0x' + '44'.repeat(32),
      challengeHash: '0x' + '55'.repeat(32),
      encryptedReceipt: '0x99'
    };
    expect(
      validateShieldedPaymentResponseShape(payload, {
        exactPublicInputsLength: 6,
        maxProofHexLength: 262144
      })
    ).toBeUndefined();
  });

  it('rejects invalid public input length', () => {
    const payload = {
      proof: '0x12',
      publicInputs: ['0x01'],
      nullifier: '0x' + '11'.repeat(32),
      root: '0x' + '22'.repeat(32),
      merchantCommitment: '0x' + '33'.repeat(32),
      changeCommitment: '0x' + '44'.repeat(32),
      challengeHash: '0x' + '55'.repeat(32),
      encryptedReceipt: '0x99'
    };
    expect(validateShieldedPaymentResponseShape(payload, { exactPublicInputsLength: 6 })).toBe(
      'invalid public input length'
    );
  });
});
