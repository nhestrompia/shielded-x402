import { X402_HEADERS, buildPaymentRequiredHeader, type PaymentRequirement } from '@shielded-x402/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShieldedFetch } from './shieldedFetch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeRequirement(): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
    payTo: '0x0000000000000000000000000000000000000002',
    rail: 'shielded-usdc',
    amount: '1500000',
    challengeNonce: '0x9999999999999999999999999999999999999999999999999999999999999999',
    challengeExpiry: String(Math.floor(Date.now() / 1000) + 300),
    merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
    verifyingContract: '0x0000000000000000000000000000000000000002'
  };
}

describe('createShieldedFetch', () => {
  it('passes through non-402 responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const prepare402Payment = vi.fn();
    const resolveContext = vi.fn();
    const shieldedFetch = createShieldedFetch({
      sdk: { prepare402Payment },
      resolveContext
    });

    const response = await shieldedFetch('https://merchant.example/protected');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(prepare402Payment).not.toHaveBeenCalled();
  });

  it('handles 402 by preparing payment and retrying', async () => {
    const requirement = makeRequirement();
    const firstResponse = new Response('payment required', {
      status: 402,
      headers: { [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement) }
    });
    const secondResponse = new Response('protected payload', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(secondResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const prepare402Payment = vi.fn().mockResolvedValue({
      requirement,
      headers: new Headers({ [X402_HEADERS.paymentSignature]: 'signed-payment-header' }),
      response: {},
      changeNote: {},
      changeNullifierSecret: '0x01'
    });

    const resolveContext = vi.fn().mockResolvedValue({
      note: {
        amount: 2_000_000n,
        rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
        pkHash: '0x0000000000000000000000000000000000000000000000000000000000000022',
        commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
        leafIndex: 0
      },
      witness: {
        root: '0x0000000000000000000000000000000000000000000000000000000000000099',
        path: [],
        indexBits: []
      },
      nullifierSecret: '0x0000000000000000000000000000000000000000000000000000000000000008'
    });

    const shieldedFetch = createShieldedFetch({
      sdk: { prepare402Payment },
      resolveContext
    });

    const response = await shieldedFetch('https://merchant.example/protected', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'purchase' })
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(prepare402Payment).toHaveBeenCalledTimes(1);

    const retryRequest = fetchMock.mock.calls[1][0] as Request;
    expect(retryRequest.headers.get(X402_HEADERS.paymentSignature)).toBe(
      'signed-payment-header'
    );
  });
});
