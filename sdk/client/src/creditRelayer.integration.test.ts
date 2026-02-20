import {
  RELAYER_ROUTES,
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type CreditDomainResponse,
  type CreditState,
  type Hex,
  type PaymentRequirement,
  type RelayerCreditPayRequest,
  type RelayerCreditTopupRequest,
  type ShieldedPaymentResponse,
  type SignedCreditState
} from '@shielded-x402/shared-types';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createCreditRelayerProcessor } from '../../../services/payment-relayer/src/creditProcessor.js';
import { createCreditChannelClient } from './creditChannel.js';
import { createCreditShieldedFetch } from './creditFetch.js';

const relayerPrivateKey =
  '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0' as Hex;
const agentPrivateKey =
  '0x8b3a350cf5c34c9194ca3a545d83a16b5d2d1f8f907f4f7b2f5f1f5a8e8e8e8e' as Hex;

const relayerEndpoint = 'http://relayer.local';
const merchantUrl = 'https://merchant.example/protected';

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

function makeDomain(): CreditDomainResponse {
  return {
    name: 'shielded-x402-credit',
    version: '1',
    chainId: 84532,
    verifyingContract: '0x0000000000000000000000000000000000000002',
    relayerAddress: privateKeyToAccount(relayerPrivateKey).address.toLowerCase() as Hex
  };
}

function makeRequirement(amount: string = '40'): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
    payTo: '0x0000000000000000000000000000000000000002',
    rail: 'shielded-usdc',
    amount,
    challengeNonce:
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    challengeExpiry: String(Math.floor(Date.now() / 1000) + 600),
    merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
    verifyingContract: '0x0000000000000000000000000000000000000002'
  };
}

function makeTopupPayload(
  amountHex: Hex = '0x0000000000000000000000000000000000000000000000000000000000000064',
  nullifier: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
): ShieldedPaymentResponse {
  return {
    proof: '0x1234',
    publicInputs: [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555555555555555555555555555',
      amountHex
    ],
    nullifier,
    root: '0x1111111111111111111111111111111111111111111111111111111111111111',
    merchantCommitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
    changeCommitment: '0x3333333333333333333333333333333333333333333333333333333333333333',
    challengeHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
    encryptedReceipt: '0x'
  };
}

async function signPayload(payload: ShieldedPaymentResponse): Promise<Hex> {
  const agent = privateKeyToAccount(agentPrivateKey);
  const signature = await agent.signMessage({
    message: JSON.stringify(payload)
  });
  return signature.toLowerCase() as Hex;
}

describe('credit SDK <-> relayer integration', () => {
  it('tops up once and serves multiple paid 402 requests while advancing co-signed state', async () => {
    const domain = makeDomain();
    const requirement = makeRequirement('40');
    const agent = privateKeyToAccount(agentPrivateKey);

    let payoutCount = 0;
    const payout = {
      payMerchant: vi.fn(async () => {
        payoutCount += 1;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.from(JSON.stringify({ ok: true, count: payoutCount }), 'utf8').toString(
            'base64'
          )
        };
      })
    };

    const processor = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({
          alreadySettled: false,
          txHash: `0x${'1'.repeat(64)}` as Hex
        })
      },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    let persisted: SignedCreditState | undefined;
    const stateStore = {
      getCreditState: () => persisted,
      setCreditState: async (state: SignedCreditState) => {
        persisted = state;
      }
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditDomain}`) {
        return new Response(JSON.stringify(domain), { status: 200 });
      }
      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditTopup}`) {
        const request = JSON.parse(String(init?.body)) as RelayerCreditTopupRequest;
        const result = await processor.handleTopup(request);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditPay}`) {
        const request = JSON.parse(String(init?.body)) as RelayerCreditPayRequest;
        const result = await processor.handlePay(request);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (url === merchantUrl) {
        return new Response(null, {
          status: 402,
          headers: {
            [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(requirement)
          }
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const creditClient = createCreditChannelClient({
      relayerEndpoint,
      agentAddress: agent.address as Hex,
      signer: {
        signTypedData: (args) => agent.signTypedData(args)
      },
      stateStore,
      fetchImpl: asFetch(fetchMock)
    });

    const topupPayload = makeTopupPayload();
    const topupResult = await creditClient.topup({
      requestId: 'integration-topup-1',
      paymentPayload: topupPayload,
      paymentPayloadSignature: await signPayload(topupPayload)
    });
    expect(topupResult.status).toBe('DONE');
    expect(persisted?.state.seq).toBe('0');
    expect(persisted?.state.available).toBe('100');

    const creditFetch = createCreditShieldedFetch({
      creditClient,
      fetchImpl: asFetch(fetchMock)
    });

    const first = await creditFetch(merchantUrl, { method: 'GET' });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"ok":true,"count":1}');

    const second = await creditFetch(merchantUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello' })
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('{"ok":true,"count":2}');

    expect(payout.payMerchant).toHaveBeenCalledTimes(2);
    expect(persisted?.state.seq).toBe('2');
    expect(persisted?.state.available).toBe('20');
    expect(persisted?.state.cumulativeSpent).toBe('80');
  });

  it('returns cached relayer result on requestId retry and does not double-charge', async () => {
    const domain = makeDomain();
    const requirement = makeRequirement('25');
    const agent = privateKeyToAccount(agentPrivateKey);

    const payout = {
      payMerchant: vi.fn(async () => ({
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
      }))
    };

    const processor = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({
          alreadySettled: false,
          txHash: `0x${'2'.repeat(64)}` as Hex
        })
      },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    let persisted: SignedCreditState | undefined;
    const stateStore = {
      getCreditState: () => persisted,
      setCreditState: async (state: SignedCreditState) => {
        persisted = state;
      }
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditDomain}`) {
        return new Response(JSON.stringify(domain), { status: 200 });
      }
      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditTopup}`) {
        const request = JSON.parse(String(init?.body)) as RelayerCreditTopupRequest;
        const result = await processor.handleTopup(request);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (url === `${relayerEndpoint}${RELAYER_ROUTES.creditPay}`) {
        const request = JSON.parse(String(init?.body)) as RelayerCreditPayRequest;
        const result = await processor.handlePay(request);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const creditClient = createCreditChannelClient({
      relayerEndpoint,
      agentAddress: agent.address as Hex,
      signer: {
        signTypedData: (args) => agent.signTypedData(args)
      },
      stateStore,
      fetchImpl: asFetch(fetchMock)
    });

    const topupPayload = makeTopupPayload(
      '0x0000000000000000000000000000000000000000000000000000000000000032',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
    const topupResult = await creditClient.topup({
      requestId: 'integration-topup-2',
      paymentPayload: topupPayload,
      paymentPayloadSignature: await signPayload(topupPayload)
    });
    expect(topupResult.status).toBe('DONE');
    expect(persisted?.state.available).toBe('50');

    const merchantRequest = { url: merchantUrl, method: 'GET' };
    const first = await creditClient.pay({
      requestId: 'retry-id-1',
      merchantRequest,
      requirement
    });
    const second = await creditClient.pay({
      requestId: 'retry-id-1',
      merchantRequest,
      requirement
    });

    expect(first.status).toBe('DONE');
    expect(second.status).toBe('DONE');
    expect(first).toEqual(second);
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
    expect(persisted?.state.seq).toBe('1');
    expect(persisted?.state.available).toBe('25');
  });
});
