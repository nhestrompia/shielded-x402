import { describe, expect, it } from 'vitest';
import { parseRelayPayRequest } from './validation.js';

describe('payment-relayer validation', () => {
  it('parses and normalizes relay pay payload', () => {
    const parsed = parseRelayPayRequest({
      authorization: {
        version: 1,
        intentId: '0X' + '11'.repeat(32),
        authId: '0X' + '22'.repeat(32),
        authorizedAmountMicros: '1000',
        agentId: '0X' + '33'.repeat(32),
        agentNonce: '1',
        merchantId: '0X' + '44'.repeat(32),
        chainRef: 'solana:devnet',
        issuedAt: '1735689500',
        expiresAt: '1735689600',
        sequencerEpochHint: '1',
        logSeqNo: '1',
        sequencerKeyId: 'seq-key-1'
      },
      sequencerSig: '0X' + 'aa'.repeat(64),
      merchantRequest: {
        url: 'https://merchant.example/pay',
        method: 'post'
      }
    });

    expect(parsed.authorization.authId).toBe('0x' + '22'.repeat(32));
    expect(parsed.merchantRequest.method).toBe('POST');
  });

  it('rejects malformed payload', () => {
    expect(() => parseRelayPayRequest(null)).toThrow('expected object');
  });
});
