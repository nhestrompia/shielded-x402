import {
  buildPaymentRequiredHeader,
  X402_HEADERS,
  type PaymentRequirement
} from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { createCreditShieldedFetch } from './creditFetch.js';

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

const requirement: PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:84532',
  asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
  payTo: '0x0000000000000000000000000000000000000002',
  rail: 'shielded-usdc',
  amount: '40',
  challengeNonce: '0x9999999999999999999999999999999999999999999999999999999999999999',
  challengeExpiry: String(Math.floor(Date.now() / 1000) + 600),
  merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
  verifyingContract: '0x0000000000000000000000000000000000000002'
};

describe('createCreditShieldedFetch', () => {
  it('returns non-402 responses unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const pay = vi.fn();
    const creditFetch = createCreditShieldedFetch({
      fetchImpl: asFetch(fetchMock),
      creditClient: { pay }
    });

    const response = await creditFetch('https://merchant.example/data', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(pay).not.toHaveBeenCalled();
  });

  it('builds merchant request and returns relayed merchant result', async () => {
    const challenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(challenge);
    const pay = vi.fn(async () => ({
      status: 'DONE' as const,
      merchantResult: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
      }
    }));

    const creditFetch = createCreditShieldedFetch({
      fetchImpl: asFetch(fetchMock),
      creditClient: { pay }
    });

    const response = await creditFetch('https://merchant.example/data?a=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ hello: 'world' })
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(pay).toHaveBeenCalledTimes(1);
    const args = pay.mock.calls[0]?.[0];
    expect(args?.merchantRequest.url).toBe('https://merchant.example/data?a=1');
    expect(args?.merchantRequest.method).toBe('POST');
    expect(args?.merchantRequest.bodyBase64).toBeDefined();
    expect(args?.requirement.amount).toBe('40');
  });

  it('throws when credit pay fails', async () => {
    const challenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(challenge);
    const pay = vi.fn(async () => ({
      status: 'FAILED' as const,
      failureReason: 'insufficient credit balance'
    }));

    const creditFetch = createCreditShieldedFetch({
      fetchImpl: asFetch(fetchMock),
      creditClient: { pay }
    });

    await expect(creditFetch('https://merchant.example/data', { method: 'GET' })).rejects.toThrow(
      'insufficient credit balance'
    );
  });
});
