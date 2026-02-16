import {
  CRYPTO_SPEC,
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type Hex,
  type PaymentRequirement,
  type ShieldedNote
} from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import { createRelayedShieldedFetch, type RelayedShieldedFetchContext } from './relayerFetch.js';

describe('createRelayedShieldedFetch', () => {
  const MERKLE_DEPTH = CRYPTO_SPEC.merkleTreeDepth;
  const requirement: PaymentRequirement = {
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
  };

  function buildContext(): RelayedShieldedFetchContext {
    const note: ShieldedNote = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011' as Hex,
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009' as Hex,
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033' as Hex,
      leafIndex: 0
    };

    const witness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex,
      path: new Array<string>(MERKLE_DEPTH).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(MERKLE_DEPTH).fill(0)
    };

    return {
      note,
      witness,
      payerPkHash: note.pkHash
    };
  }

  function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
    return mock as unknown as typeof fetch;
  }

  it('relays locally-generated proof to relayer and returns merchant response', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });

    const relayerResult = {
      settlementId: 'settle_abc',
      status: 'DONE',
      nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
      settlementTxHash: '0xabc',
      merchantResult: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
      }
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(new Response(JSON.stringify(relayerResult), { status: 200 }));

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext(),
      challengeUrlResolver: () => 'http://merchant.local/x402/requirement'
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const relayCall = fetchMock.mock.calls[1];
    expect(relayCall?.[0]).toBe('http://relayer.local/v1/relay/pay');

    const relayInit = relayCall?.[1] as RequestInit;
    const relayBody = JSON.parse(String(relayInit.body)) as {
      merchantRequest: { challengeUrl?: string; bodyBase64?: string };
      paymentSignatureHeader: string;
    };
    expect(relayBody.merchantRequest.challengeUrl).toBe('http://merchant.local/x402/requirement');
    expect(relayBody.merchantRequest.bodyBase64).toBeUndefined();
    expect(relayBody.paymentSignatureHeader.length).toBeGreaterThan(10);
  });

  it('bridges unsupported merchant rail through relayer challenge endpoint', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader({
          ...requirement,
          rail: 'normal-usdc'
        })
      }
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requirement,
            paymentRequiredHeader: buildPaymentRequiredHeader(requirement),
            upstreamRequirementHash:
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settlementId: 'settle_bridge',
            status: 'DONE',
            nullifier:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            merchantResult: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
            }
          }),
          { status: 200 }
        )
      );
    const fallback = vi.fn(async () => new Response('fallback', { status: 409 }));

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext(),
      onUnsupportedRail: fallback
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(fallback).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://relayer.local/v1/relay/challenge');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://relayer.local/v1/relay/pay');
  });

  it('supports merchants returning 402 body requirements without PAYMENT-REQUIRED header', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(
      JSON.stringify({
        x402Version: 2,
        requirements: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            amount: '40',
            payTo: '0x0000000000000000000000000000000000000002',
            asset: '0x0000000000000000000000000000000000000000000000000000000000000000'
          }
        ]
      }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json'
        }
      }
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requirement,
            paymentRequiredHeader: buildPaymentRequiredHeader(requirement),
            upstreamRequirementHash:
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settlementId: 'settle_bridge_body_only',
            status: 'DONE',
            nullifier:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            merchantResult: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
            }
          }),
          { status: 200 }
        )
      );

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext()
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://relayer.local/v1/relay/challenge');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://relayer.local/v1/relay/pay');
  });

  it('returns relay failure details as 502 when merchant result is absent', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settlementId: 'settle_fail',
            status: 'FAILED',
            nullifier:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            failureReason: 'challenge mismatch'
          }),
          { status: 422 }
        )
      );

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext()
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.status).toBe('FAILED');
  });

  it('preserves binary merchant response bytes from relayer result', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });

    const binary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x7f]);
    const relayerResult = {
      settlementId: 'settle_bin',
      status: 'DONE',
      nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
      merchantResult: {
        status: 200,
        headers: { 'content-type': 'image/png' },
        bodyBase64: Buffer.from(binary).toString('base64')
      }
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(new Response(JSON.stringify(relayerResult), { status: 200 }));

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext()
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(binary));
  });

  it('serializes request bodies as base64 bytes for relay transport', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig',
      proofProvider: {
        generateProof: async ({ expectedPublicInputs }) => ({
          proof: '0x1234',
          publicInputs: expectedPublicInputs
        })
      }
    });

    const merchantChallenge = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
      }
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settlementId: 'settle_req',
            status: 'DONE',
            nullifier:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            merchantResult: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
            }
          }),
          { status: 200 }
        )
      );

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock),
      resolveContext: async () => buildContext()
    });

    const requestBytes = Uint8Array.from([0x00, 0xff, 0x11, 0x22, 0x33, 0x44]);
    await relayedFetch('http://merchant.local/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: requestBytes
    });

    const relayCall = fetchMock.mock.calls[1];
    const relayInit = relayCall?.[1] as RequestInit;
    const relayBody = JSON.parse(String(relayInit.body)) as {
      merchantRequest: { bodyBase64?: string };
    };
    expect(relayBody.merchantRequest.bodyBase64).toBe(Buffer.from(requestBytes).toString('base64'));
  });
});
