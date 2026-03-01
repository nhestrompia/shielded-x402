import { describe, expect, it, vi } from 'vitest';
import type { AuthorizeResponseV1, RelayPayResponseV1 } from '@shielded-x402/shared-types';
import { MultiChainCreditClient } from './multiChainCredit.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('MultiChainCreditClient', () => {
  it('routes authorize calls to sequencer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://sequencer.local/v1/credit/authorize');
      const response: AuthorizeResponseV1 = {
        authorization: {
          version: 1,
          intentId: '0x11'.padEnd(66, '1') as `0x${string}`,
          authId: '0x22'.padEnd(66, '2') as `0x${string}`,
          authorizedAmountMicros: '10',
          agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
          agentNonce: '0',
          merchantId: '0x44'.padEnd(66, '4') as `0x${string}`,
          chainRef: 'solana:devnet',
          issuedAt: '1',
          expiresAt: '2',
          sequencerEpochHint: '1',
          logSeqNo: '1',
          sequencerKeyId: 'seq-key-1'
        },
        sequencerSig: '0x55'.padEnd(130, '5') as `0x${string}`,
        idempotent: false
      };
      return jsonResponse(200, response);
    });

    const client = new MultiChainCreditClient({
      sequencerUrl: 'http://sequencer.local',
      relayerUrls: {
        'solana:devnet': 'http://solana-relayer.local'
      },
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await client.authorize({
      intent: {
        version: 1,
        agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
        agentPubKey: '0xaa'.padEnd(66, 'a') as `0x${string}`,
        signatureScheme: 'ed25519-sha256-v1',
        agentNonce: '0',
        amountMicros: '10',
        merchantId: '0x44'.padEnd(66, '4') as `0x${string}`,
        requiredChainRef: 'solana:devnet',
        expiresAt: '2',
        requestId: '0x66'.padEnd(66, '6') as `0x${string}`
      },
      agentSig: '0x77'.padEnd(130, '7') as `0x${string}`
    });

    expect(result.authorization.chainRef).toBe('solana:devnet');
  });

  it('routes pay to matching chain relayer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://base-relayer.local/v1/relay/pay');
      const response: RelayPayResponseV1 = {
        executionTxHash: '0x88'.padEnd(66, '8') as `0x${string}`,
        authId: '0x99'.padEnd(66, '9') as `0x${string}`,
        status: 'DONE'
      };
      return jsonResponse(200, response);
    });

    const client = new MultiChainCreditClient({
      sequencerUrl: 'http://sequencer.local',
      relayerUrls: {
        'eip155:8453': 'http://base-relayer.local',
        'solana:devnet': 'http://solana-relayer.local'
      },
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await client.relayPay({
      authorization: {
        version: 1,
        intentId: '0x11'.padEnd(66, '1') as `0x${string}`,
        authId: '0x99'.padEnd(66, '9') as `0x${string}`,
        authorizedAmountMicros: '10',
        agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
        agentNonce: '1',
        merchantId: '0x44'.padEnd(66, '4') as `0x${string}`,
        chainRef: 'eip155:8453',
        issuedAt: '1',
        expiresAt: '100000',
        sequencerEpochHint: '1',
        logSeqNo: '2',
        sequencerKeyId: 'seq-key-1'
      },
      sequencerSig: '0xaa'.padEnd(130, 'a') as `0x${string}`,
      merchantRequest: {
        url: 'https://merchant.local/pay',
        method: 'POST'
      }
    });

    expect(result.status).toBe('DONE');
  });

  it('fails if relayer mapping is missing for chainRef', async () => {
    const client = new MultiChainCreditClient({
      sequencerUrl: 'http://sequencer.local',
      relayerUrls: {},
      fetchImpl: vi.fn() as unknown as typeof fetch
    });

    await expect(
      client.relayPay({
        authorization: {
          version: 1,
          intentId: '0x11'.padEnd(66, '1') as `0x${string}`,
          authId: '0x99'.padEnd(66, '9') as `0x${string}`,
          authorizedAmountMicros: '10',
          agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
          agentNonce: '1',
          merchantId: '0x44'.padEnd(66, '4') as `0x${string}`,
          chainRef: 'solana:devnet',
          issuedAt: '1',
          expiresAt: '100000',
          sequencerEpochHint: '1',
          logSeqNo: '2',
          sequencerKeyId: 'seq-key-1'
        },
        sequencerSig: '0xaa'.padEnd(130, 'a') as `0x${string}`,
        merchantRequest: {
          url: 'https://merchant.local/pay',
          method: 'POST'
        }
      })
    ).rejects.toThrow('no relayer configured for chainRef solana:devnet');
  });

  it('pay() orchestrates authorize + relayPay with one call', async () => {
    const authorizeResponse: AuthorizeResponseV1 = {
      authorization: {
        version: 1,
        intentId: '0x11'.padEnd(66, '1') as `0x${string}`,
        authId: '0x22'.padEnd(66, '2') as `0x${string}`,
        authorizedAmountMicros: '1500000',
        agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
        agentNonce: '5',
        merchantId: '0x44'.padEnd(66, '4') as `0x${string}`,
        chainRef: 'solana:devnet',
        issuedAt: '1',
        expiresAt: '100000',
        sequencerEpochHint: '1',
        logSeqNo: '2',
        sequencerKeyId: 'seq-key-1'
      },
      sequencerSig: '0xaa'.padEnd(130, 'a') as `0x${string}`,
      idempotent: false
    };

    const relayResponse: RelayPayResponseV1 = {
      executionTxHash: '0x55'.padEnd(66, '5') as `0x${string}`,
      authId: authorizeResponse.authorization.authId,
      status: 'DONE'
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, authorizeResponse))
      .mockResolvedValueOnce(jsonResponse(200, relayResponse));

    const signIntent = vi.fn(async () => ('0xbb'.padEnd(130, 'b') as `0x${string}`));
    const client = new MultiChainCreditClient({
      sequencerUrl: 'http://sequencer.local',
      relayerUrls: {
        'solana:devnet': 'http://solana-relayer.local'
      },
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await client.pay({
      chainRef: 'solana:devnet',
      amountMicros: '1500000',
      merchant: {
        serviceRegistryId: 'demo/sol',
        endpointUrl: 'https://merchant.solana.example/pay'
      },
      merchantRequest: {
        url: 'https://merchant.solana.example/pay',
        method: 'POST'
      },
      agent: {
        agentId: '0x33'.padEnd(66, '3') as `0x${string}`,
        agentPubKey: '0xcc'.padEnd(66, 'c') as `0x${string}`,
        signatureScheme: 'ed25519-sha256-v1',
        agentNonce: '5',
        signIntent
      }
    });

    expect(signIntent).toHaveBeenCalledTimes(1);
    expect(result.authorize.authorization.chainRef).toBe('solana:devnet');
    expect(result.relay.status).toBe('DONE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://sequencer.local/v1/credit/authorize');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://solana-relayer.local/v1/relay/pay');
  });
});
