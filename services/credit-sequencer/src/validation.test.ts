import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionTxHash,
  parseAdminCreditRequest,
  parseAuthorizeRequest,
  parseExecutionReport,
  parseReclaimRequest
} from './validation.js';

describe('credit-sequencer validation', () => {
  it('parses authorize payload', () => {
    const parsed = parseAuthorizeRequest({
      intent: {
        version: 1,
        agentId: '0x' + '11'.repeat(32),
        agentPubKey: '0x' + '22'.repeat(32),
        signatureScheme: 'ed25519-sha256-v1',
        agentNonce: '1',
        amountMicros: '1000',
        merchantId: '0x' + '33'.repeat(32),
        requiredChainRef: 'solana:devnet',
        expiresAt: '1735689600',
        requestId: '0x' + '44'.repeat(32)
      },
      agentSig: '0x' + '55'.repeat(64)
    });

    expect(parsed.intent.requiredChainRef).toBe('solana:devnet');
    expect(parsed.intent.agentNonce).toBe('1');
  });

  it('accepts non-hex tx hashes for execution reports', () => {
    const parsed = parseExecutionReport({
      authId: '0x' + 'aa'.repeat(32),
      chainRef: 'solana:devnet',
      executionTxHash: '5rArh7M4u8wJSEYqt7dVm1S4VfU8xEW6PF8gZXD8g9xXk1r9Haqrj9CTYTL4Q9v5xP9uHjR8',
      status: 'SUCCESS',
      reportId: '0x' + 'bb'.repeat(32),
      reportedAt: '1735689601',
      relayerKeyId: 'sol-relayer-1',
      reportSig: '0x' + 'cc'.repeat(64)
    });
    expect(parsed.executionTxHash.startsWith('5rArh7')).toBe(true);
  });

  it('normalizes hex tx hashes', () => {
    expect(normalizeExecutionTxHash('0XAB')).toBe('0xab');
  });

  it('parses reclaim payload', () => {
    const parsed = parseReclaimRequest({
      authId: '0x' + 'aa'.repeat(32),
      callerType: 'agent',
      agentId: '0x' + 'bb'.repeat(32),
      requestedAt: '1735689602',
      agentSig: '0x' + 'cc'.repeat(64)
    });
    expect(parsed.callerType).toBe('agent');
    expect(parsed.agentId).toBe('0x' + 'bb'.repeat(32));
  });

  it('rejects non-positive admin credit amounts', () => {
    expect(() =>
      parseAdminCreditRequest({
        agentId: '0x' + '11'.repeat(32),
        amountMicros: '0'
      })
    ).toThrow('amountMicros must be > 0');
  });
});
