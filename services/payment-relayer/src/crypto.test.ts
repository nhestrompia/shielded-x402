import { describe, expect, it } from 'vitest';
import {
  createExecutionReport,
  createEd25519PrivateKeyFromSeed,
  parsePrivateSeed,
  parseSequencerKeyMap
} from './crypto.js';

describe('payment-relayer crypto helpers', () => {
  it('parses private seed from 32-byte and 64-byte values', () => {
    const seed32 = `0x${'11'.repeat(32)}`;
    const seed64 = `0x${'22'.repeat(64)}`;
    expect(parsePrivateSeed(seed32)).toHaveLength(32);
    expect(parsePrivateSeed(seed64)).toHaveLength(32);
  });

  it('parses sequencer key map entries', () => {
    const parsed = parseSequencerKeyMap(JSON.stringify({ 'seq-1': `0x${'aa'.repeat(32)}` }));
    expect(parsed['seq-1']).toBe(`0x${'aa'.repeat(32)}`);
  });

  it('creates signed execution report', () => {
    const privateKey = createEd25519PrivateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 7)));
    const report = createExecutionReport({
      authId: `0x${'11'.repeat(32)}`,
      chainRef: 'solana:devnet',
      executionTxHash: 'abc123',
      status: 'SUCCESS',
      relayerKeyId: 'relayer-1',
      privateKey
    });
    expect(report.authId).toBe(`0x${'11'.repeat(32)}`);
    expect(report.reportSig.startsWith('0x')).toBe(true);
  });
});
