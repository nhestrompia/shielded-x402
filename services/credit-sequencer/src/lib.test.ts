import { describe, expect, it } from 'vitest';
import {
  errorCodeFromMessage,
  keyIdToBytes32,
  parseSequencerPrivateKey,
  parseSupportedChainRefs
} from './lib.js';

describe('credit-sequencer lib', () => {
  it('parses supported chain refs with defaults', () => {
    const refs = parseSupportedChainRefs(undefined);
    expect(refs.has('eip155:8453')).toBe(true);
    expect(refs.has('solana:devnet')).toBe(true);
  });

  it('maps known error codes', () => {
    expect(errorCodeFromMessage('CONFLICT_EXECUTION for authId')).toBe('CONFLICT_EXECUTION');
    expect(errorCodeFromMessage('UNAUTHORIZED_REPORTER')).toBe('UNAUTHORIZED_REPORTER');
    expect(errorCodeFromMessage('random bad request')).toBe('INVALID_REQUEST');
  });

  it('converts key id to bytes32 and parses sequencer private keys', () => {
    const bytes32 = keyIdToBytes32('seq-key-1');
    expect(bytes32).toMatch(/^0x[0-9a-f]{64}$/);

    const seed = `0x${'11'.repeat(32)}`;
    expect(parseSequencerPrivateKey(seed)).toHaveLength(32);
  });
});
