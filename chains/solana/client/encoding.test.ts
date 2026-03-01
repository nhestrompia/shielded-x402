import { describe, expect, it } from 'vitest';
import { authIdToBytes, buildPayAuthorizedData, u64ToLeBytes } from './encoding.js';

describe('solana pay-authorized encoding', () => {
  it('encodes auth id as 32 bytes', () => {
    const bytes = authIdToBytes(`0x${'ab'.repeat(32)}`);
    expect(bytes.length).toBe(32);
    expect(Buffer.from(bytes).toString('hex')).toBe('ab'.repeat(32));
  });

  it('encodes u64 little endian', () => {
    const bytes = u64ToLeBytes(513n);
    expect(Array.from(bytes.slice(0, 3))).toEqual([1, 2, 0]);
  });

  it('builds instruction payload with fixed header layout', () => {
    const proof = Uint8Array.from([1, 2, 3]);
    const publicWitness = Uint8Array.from([4, 5]);
    const data = buildPayAuthorizedData({
      authIdHex: `0x${'11'.repeat(32)}`,
      amountLamports: 9n,
      authExpiryUnix: 10n,
      proof,
      publicWitness
    });
    expect(data.length).toBe(32 + 8 + 8 + proof.length + publicWitness.length);
    expect(Array.from(data.slice(48, 51))).toEqual([1, 2, 3]);
    expect(Array.from(data.slice(51, 53))).toEqual([4, 5]);
  });
});
