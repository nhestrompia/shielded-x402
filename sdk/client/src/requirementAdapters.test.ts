import {
  X402_HEADERS,
  buildPaymentRequiredHeader,
  encodeX402Header,
  type PaymentRequirement
} from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createGenericX402V2Adapter,
  parseRequirementFrom402Response,
  rewriteOutgoingHeadersWithAdapters,
  type RequirementAdapter
} from './requirementAdapters.js';

function makeRequirement(): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
    payTo: '0x0000000000000000000000000000000000000002',
    rail: 'shielded-usdc',
    amount: '10000',
    challengeNonce: '0x9999999999999999999999999999999999999999999999999999999999999999',
    challengeExpiry: String(Date.now() + 60_000),
    merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
    verifyingContract: '0x0000000000000000000000000000000000000003'
  };
}

describe('requirementAdapters', () => {
  it('passes through canonical x402 v2 payment-required headers', async () => {
    const requirement = makeRequirement();
    const header = buildPaymentRequiredHeader(requirement);
    const response = new Response(null, {
      status: 402,
      headers: { [X402_HEADERS.paymentRequired]: header }
    });

    const parsed = await parseRequirementFrom402Response(
      response,
      { requestUrl: 'https://merchant.example.com/paid' },
      [createGenericX402V2Adapter()]
    );

    expect(parsed.requirement.amount).toBe('10000');
    expect(parsed.response.headers.get(X402_HEADERS.paymentRequired)).toBeTruthy();
  });

  it('rejects malformed 402 payloads that cannot be normalized', async () => {
    const response = new Response(JSON.stringify({ error: 'bad payload' }), {
      status: 402,
      headers: { 'content-type': 'application/json' }
    });

    await expect(
      parseRequirementFrom402Response(
        response,
        { requestUrl: 'https://merchant.example.com/paid' },
        [createGenericX402V2Adapter()]
      )
    ).rejects.toThrow(`missing ${X402_HEADERS.paymentRequired} header`);
  });

  it('repairs direct payment-required headers missing shielded metadata', async () => {
    const header = encodeX402Header({
      x402Version: 2 as const,
      accepts: [
        {
          scheme: 'exact',
          network: 'base-sepolia',
          payTo: '0x00000000000000000000000000000000000000aa',
          maxAmountRequired: '4000'
        }
      ]
    });
    const response = new Response(null, {
      status: 402,
      headers: { [X402_HEADERS.paymentRequired]: header }
    });

    const parsed = await parseRequirementFrom402Response(
      response,
      { requestUrl: 'https://merchant.example.com/paid' },
      [createGenericX402V2Adapter()]
    );

    expect(parsed.requirement.amount).toBe('4000');
    expect(parsed.requirement.rail).toBe('x402-standard');
    expect(parsed.requirement.challengeNonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(parsed.requirement.verifyingContract).toBe(
      '0x00000000000000000000000000000000000000aa'
    );
  });

  it('applies first incoming adapter transform and then stops incoming chain', async () => {
    const requirement = makeRequirement();
    const firstAdapter: RequirementAdapter = {
      name: 'first',
      normalizeIncoming402: async (response) =>
        new Response(response.body, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
          }
        })
    };
    const secondNormalize = vi.fn(async (response: Response) => response);
    const secondAdapter: RequirementAdapter = {
      name: 'second',
      normalizeIncoming402: secondNormalize
    };
    const response = new Response(JSON.stringify({}), {
      status: 402,
      headers: { 'content-type': 'application/json' }
    });

    const parsed = await parseRequirementFrom402Response(
      response,
      { requestUrl: 'https://merchant.example.com/paid' },
      [firstAdapter, secondAdapter]
    );
    expect(parsed.requirement.amount).toBe('10000');
    expect(secondNormalize).toHaveBeenCalledTimes(0);
  });

  it('applies outgoing header rewrites sequentially', () => {
    const base = new Headers({ [X402_HEADERS.paymentSignature]: 'sig' });
    const adapters: RequirementAdapter[] = [
      {
        name: 'a',
        rewriteOutgoingPaymentHeaders: (headers) => {
          const out = new Headers(headers);
          out.set('x-a', '1');
          return out;
        }
      },
      {
        name: 'b',
        rewriteOutgoingPaymentHeaders: (headers) => {
          const out = new Headers(headers);
          out.set('x-b', out.get('x-a') === '1' ? '2' : '0');
          return out;
        }
      }
    ];

    const rewritten = rewriteOutgoingHeadersWithAdapters(
      base,
      { requestUrl: 'https://merchant.example.com/paid' },
      adapters
    );
    expect(rewritten.get('x-a')).toBe('1');
    expect(rewritten.get('x-b')).toBe('2');
  });
});
