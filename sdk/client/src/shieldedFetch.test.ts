import { X402_HEADERS, type Hex } from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import { createShieldedFetch } from './shieldedFetch.js';

describe('createShieldedFetch', () => {
  it('completes a shielded 402 flow with resolved context', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;
    const witness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099',
      path: new Array<string>(32).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(32).fill(0)
    };

    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const requirement = {
      rail: 'shielded-usdc',
      amount: '40',
      challengeNonce:
        '0x9999999999999999999999999999999999999999999999999999999999999999',
      challengeExpiry: String(Date.now() + 60_000),
      merchantPubKey:
        '0x0000000000000000000000000000000000000000000000000000000000000012',
      verifyingContract: '0x0000000000000000000000000000000000000002'
    } as const;

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequirement]: JSON.stringify(requirement)
      }
    });
    const second = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second) as typeof fetch;
    const resolveContext = vi.fn(async () => ({
      note,
      witness,
      payerPkHash: note.pkHash
    }));

    const shieldedFetch = createShieldedFetch({
      sdk,
      resolveContext,
      fetchImpl
    });

    const response = await shieldedFetch('http://localhost:3000/paid/data', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers((fetchImpl.mock.calls[1] ?? [])[1]?.headers);
    expect(retryHeaders.has(X402_HEADERS.paymentResponse)).toBe(true);
    expect(retryHeaders.has(X402_HEADERS.paymentSignature)).toBe(true);
    expect(retryHeaders.has(X402_HEADERS.challengeNonce)).toBe(true);
  });

  it('routes unsupported rail to fallback handler', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig'
    });

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequirement]: JSON.stringify({
          rail: 'normal-usdc',
          amount: '1',
          challengeNonce: '0x01',
          challengeExpiry: String(Date.now() + 60_000),
          merchantPubKey:
            '0x0000000000000000000000000000000000000000000000000000000000000012',
          verifyingContract: '0x0000000000000000000000000000000000000002'
        })
      }
    });

    const fetchImpl = vi.fn().mockResolvedValueOnce(first) as typeof fetch;
    const fallback = vi.fn(async () => new Response('fallback', { status: 409 }));

    const shieldedFetch = createShieldedFetch({
      sdk,
      resolveContext: async () => {
        throw new Error('must not be called');
      },
      onUnsupportedRail: fallback,
      fetchImpl
    });

    const response = await shieldedFetch('http://localhost:3000/paid/data', { method: 'GET' });
    expect(response.status).toBe(409);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
