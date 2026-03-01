import { describe, expect, it } from 'vitest';
import { deriveExecutionTxHash, isPrivateIp, isRelayCallerAuthorized } from './lib.js';

describe('relayer lib', () => {
  it('uses deterministic noop execution hash', () => {
    const input = {
      authId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      chainRef: 'solana:devnet',
      payoutMode: 'noop' as const,
      merchantResult: {
        status: 200,
        bodyBase64: Buffer.from('ok').toString('base64')
      }
    };
    const hashA = deriveExecutionTxHash(input);
    const hashB = deriveExecutionTxHash(input);
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('uses adapter tx hash for evm mode', () => {
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const hash = deriveExecutionTxHash({
      authId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chainRef: 'eip155:84532',
      payoutMode: 'evm',
      merchantResult: {
        status: 200,
        bodyBase64: Buffer.from(JSON.stringify({ txHash }), 'utf8').toString('base64')
      }
    });
    expect(hash).toBe(txHash);
  });

  it('flags private/internal IP ranges', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('192.168.1.2')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('authorizes caller token when configured', () => {
    expect(isRelayCallerAuthorized(undefined, undefined)).toBe(true);
    expect(isRelayCallerAuthorized('secret', undefined)).toBe(false);
    expect(isRelayCallerAuthorized('secret', 'wrong')).toBe(false);
    expect(isRelayCallerAuthorized('secret', 'secret')).toBe(true);
  });
});
