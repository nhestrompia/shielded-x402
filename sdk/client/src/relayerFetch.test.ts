import {
  CRYPTO_SPEC,
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type Hex,
  type PaymentRequirement
} from '@shielded-x402/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import { createRelayedShieldedFetch } from './relayerFetch.js';

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

  function buildContext() {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;

    const witness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099',
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
        body: '{"ok":true}'
      }
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(merchantChallenge)
      .mockResolvedValueOnce(new Response(JSON.stringify(relayerResult), { status: 200 })) as typeof fetch;

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl,
      resolveContext: async () => buildContext(),
      challengeUrlResolver: () => 'http://merchant.local/x402/requirement'
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const relayCall = fetchImpl.mock.calls[1];
    expect(relayCall?.[0]).toBe('http://relayer.local/v1/relay/pay');

    const relayInit = relayCall?.[1] as RequestInit;
    const relayBody = JSON.parse(String(relayInit.body)) as {
      merchantRequest: { challengeUrl?: string };
      paymentSignatureHeader: string;
    };
    expect(relayBody.merchantRequest.challengeUrl).toBe('http://merchant.local/x402/requirement');
    expect(relayBody.paymentSignatureHeader.length).toBeGreaterThan(10);
  });

  it('falls back for unsupported rails', async () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://merchant.local',
      signer: async () => '0xsig'
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

    const fetchImpl = vi.fn().mockResolvedValueOnce(merchantChallenge) as typeof fetch;
    const fallback = vi.fn(async () => new Response('fallback', { status: 409 }));

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl,
      resolveContext: async () => buildContext(),
      onUnsupportedRail: fallback
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(409);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    const fetchImpl = vi
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
      ) as typeof fetch;

    const relayedFetch = createRelayedShieldedFetch({
      sdk,
      relayerEndpoint: 'http://relayer.local',
      fetchImpl,
      resolveContext: async () => buildContext()
    });

    const response = await relayedFetch('http://merchant.local/paid', { method: 'GET' });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.status).toBe('FAILED');
  });
});
