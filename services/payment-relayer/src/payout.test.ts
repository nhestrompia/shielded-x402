import { describe, expect, it, vi } from 'vitest';
import { X402_HEADERS, type RelayerMerchantResult } from '@shielded-x402/shared-types';
import {
  createPayaiX402ProviderAdapter,
  createX402PayoutAdapter,
  type X402ProviderAdapter
} from './payout.js';

function decodeBody(result: RelayerMerchantResult): Record<string, unknown> {
  return JSON.parse(Buffer.from(result.bodyBase64, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('x402 payout provider adapters', () => {
  it('rewrites payai outbound payment network to eip155 caip format', async () => {
    let seenHeaders = new Headers();
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response('ok', { status: 200 });
    });

    const payout = createX402PayoutAdapter({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0',
      fetchImpl,
      providerAdapters: [createPayaiX402ProviderAdapter()],
      wrapFetchWithPayment: (baseFetch) => {
        return async (input, init) => {
          const headers = new Headers(init?.headers);
          const payment = {
            x402Version: 2,
            scheme: 'exact',
            network: 'base-sepolia',
            payload: {
              authorization: {
                from: '0x1',
                to: '0x2',
                value: '10000',
                validAfter: '1',
                validBefore: '2',
                nonce: '0x3'
              },
              signature: '0x4'
            }
          };
          const encoded = Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
          headers.set('X-PAYMENT', encoded);
          return baseFetch(input, { ...(init ?? {}), headers });
        };
      }
    });

    await payout.payMerchant({
      settlementId: 'settlement-0',
      nullifier: '0x0',
      merchantRequest: {
        url: 'https://x402.payai.network/api/base-sepolia/paid-content',
        method: 'GET'
      },
      requirement: {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x2a835A505d4Ea32372Cc420d2663b885cE089453',
        rail: 'shielded-usdc',
        amount: '10000',
        challengeNonce: '0x1',
        challengeExpiry: '1',
        merchantPubKey: '0x1',
        verifyingContract: '0x1'
      }
    });

    const outboundHeader = seenHeaders.get('x-payment');
    expect(outboundHeader).toBeTruthy();
    const decodedOutbound = JSON.parse(
      Buffer.from(outboundHeader as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(decodedOutbound.network).toBe('eip155:84532');
  });

  it('normalizes payai-style requirements body via provider adapter', async () => {
    let seenHeaders = new Headers();
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          requirements: [
            {
              scheme: 'exact',
              network: 'eip155:84532',
              amount: '10000',
              payTo: '0x2a835A505d4Ea32372Cc420d2663b885cE089453',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
            }
          ]
        }),
        { status: 402, headers: { 'content-type': 'application/json' } }
      );
    });

    const payout = createX402PayoutAdapter({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0',
      fetchImpl,
      providerAdapters: [createPayaiX402ProviderAdapter()],
      wrapFetchWithPayment: (baseFetch) => {
        return async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set(X402_HEADERS.paymentSignature, 'signed-payment');
          return baseFetch(input, { ...(init ?? {}), headers });
        };
      }
    });

    const result = await payout.payMerchant({
      settlementId: 'settlement-1',
      nullifier: '0x1',
      merchantRequest: {
        url: 'https://x402.payai.network/api/base-sepolia/paid-content',
        method: 'GET'
      },
      requirement: {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x2a835A505d4Ea32372Cc420d2663b885cE089453',
        rail: 'shielded-usdc',
        amount: '10000',
        challengeNonce: '0x1',
        challengeExpiry: '1',
        merchantPubKey: '0x1',
        verifyingContract: '0x1'
      }
    });

    const parsedBody = decodeBody(result);
    const accepts = parsedBody.accepts as Array<Record<string, unknown>>;
    expect(Array.isArray(accepts)).toBe(true);
    expect(accepts[0]?.network).toBe('base-sepolia');
    expect(accepts[0]?.maxAmountRequired).toBe('10000');
    expect(accepts[0]?.resource).toBe('https://x402.payai.network/api/base-sepolia/paid-content');
    expect(seenHeaders.get(X402_HEADERS.paymentSignature)).toBe('signed-payment');
    expect(seenHeaders.get('x-payment')).toBe('signed-payment');
  });

  it('allows custom normalized-body transforms for provider-specific fields', async () => {
    const providerAdapter: X402ProviderAdapter = {
      matches: () => true,
      transformNormalized402Body: (body) => {
        const accepts = Array.isArray(body.accepts) ? [...body.accepts] : [];
        if (accepts.length === 0) return body;
        const first = accepts[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return body;
        accepts[0] = {
          ...(first as Record<string, unknown>),
          description: 'provider override'
        };
        return { ...body, accepts };
      }
    };

    const payout = createX402PayoutAdapter({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                amount: '10000',
                payTo: '0x2a835A505d4Ea32372Cc420d2663b885cE089453',
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
              }
            ]
          }),
          { status: 402, headers: { 'content-type': 'application/json' } }
        ),
      providerAdapters: [providerAdapter],
      wrapFetchWithPayment: (baseFetch) => baseFetch
    });

    const result = await payout.payMerchant({
      settlementId: 'settlement-2',
      nullifier: '0x2',
      merchantRequest: {
        url: 'https://merchant.example/x402',
        method: 'GET'
      },
      requirement: {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x2a835A505d4Ea32372Cc420d2663b885cE089453',
        rail: 'shielded-usdc',
        amount: '10000',
        challengeNonce: '0x1',
        challengeExpiry: '1',
        merchantPubKey: '0x1',
        verifyingContract: '0x1'
      }
    });

    const parsedBody = decodeBody(result);
    const accepts = parsedBody.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]?.description).toBe('provider override');
  });
});
