import {
  CRYPTO_SPEC,
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type Hex,
  type PaymentRequirement
} from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import type { MerkleWitness } from './merkle.js';
import { createShieldedFetch } from './shieldedFetch.js';

describe('createShieldedFetch', () => {
  const MERKLE_DEPTH = CRYPTO_SPEC.merkleTreeDepth;
  const makeRequirement = (): PaymentRequirement => ({
    scheme: 'exact',
    network: 'eip155:11155111',
    asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
    payTo: '0x0000000000000000000000000000000000000002',
    rail: 'shielded-usdc',
    amount: '40',
    challengeNonce: '0x9999999999999999999999999999999999999999999999999999999999999999',
    challengeExpiry: String(Date.now() + 60_000),
    merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
    verifyingContract: '0x0000000000000000000000000000000000000002'
  });

  it('completes a shielded 402 flow with resolved context', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;
    const witness: MerkleWitness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex,
      path: new Array<string>(MERKLE_DEPTH).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(MERKLE_DEPTH).fill(0)
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

    const requirement = makeRequirement();

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });
    const second = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const resolveContext = vi.fn(async () => ({
      note,
      witness,
      nullifierSecret: '0x0000000000000000000000000000000000000000000000000000000000000008'
    }));

    const shieldedFetch = createShieldedFetch({
      sdk,
      resolveContext,
      fetchImpl
    });

    const response = await shieldedFetch('http://localhost:3000/paid/data', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers((fetchMock.mock.calls[1] ?? [])[1]?.headers);
    expect(retryHeaders.has(X402_HEADERS.paymentSignature)).toBe(true);
  });

  it('routes unsupported rail to fallback handler', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig'
    });

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader({
          ...makeRequirement(),
          rail: 'normal-usdc',
        })
      }
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(first);
    const fetchImpl = fetchMock as unknown as typeof fetch;
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

  it('can prefetch a requirement and send a paid request in one round-trip', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;
    const witness: MerkleWitness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex,
      path: new Array<string>(MERKLE_DEPTH).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(MERKLE_DEPTH).fill(0)
    };
    const requirement = makeRequirement();

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
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const resolveContext = vi.fn(async () => ({
      note,
      witness,
      nullifierSecret: '0x0000000000000000000000000000000000000000000000000000000000000008'
    }));
    const prefetchRequirement = vi.fn(async () => requirement);
    const shieldedFetch = createShieldedFetch({
      sdk,
      resolveContext,
      prefetchRequirement,
      fetchImpl
    });

    const response = await shieldedFetch('http://localhost:3000/paid/data', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(prefetchRequirement).toHaveBeenCalledTimes(1);
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstHeaders = new Headers((fetchMock.mock.calls[0] ?? [])[1]?.headers);
    expect(firstHeaders.has(X402_HEADERS.paymentSignature)).toBe(true);
  });

  it('switches to relayed mode when relayerEndpoint is provided', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;
    const witness: MerkleWitness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex,
      path: new Array<string>(MERKLE_DEPTH).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(MERKLE_DEPTH).fill(0)
    };
    const requirement = makeRequirement();

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

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });

    const relayerResult = new Response(
      JSON.stringify({
        settlementId: 'settle_abc',
        status: 'DONE',
        nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
        merchantResult: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
        }
      }),
      { status: 200 }
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(relayerResult);
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const shieldedFetch = createShieldedFetch({
      sdk,
      resolveContext: async () => ({
        note,
        witness,
        nullifierSecret: '0x0000000000000000000000000000000000000000000000000000000000000008'
      }),
      fetchImpl,
      relayerEndpoint: 'http://relayer.local'
    });

    const response = await shieldedFetch('http://localhost:3000/paid/data', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://relayer.local/v1/relay/pay');
  });
});
