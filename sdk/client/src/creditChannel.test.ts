import {
  CREDIT_EIP712_TYPES,
  deriveCreditChannelId,
  toCreditStateTypedData,
  toEip712Domain,
  type CreditDomainResponse,
  type CreditState,
  type Hex,
  type PaymentRequirement,
  type SignedCreditState
} from '@shielded-x402/shared-types';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createCreditChannelClient } from './creditChannel.js';

const agentPrivateKey =
  '0x8b3a350cf5c34c9194ca3a545d83a16b5d2d1f8f907f4f7b2f5f1f5a8e8e8e8e' as Hex;
const relayerPrivateKey =
  '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0' as Hex;

const domain: CreditDomainResponse = {
  name: 'shielded-x402-credit',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x0000000000000000000000000000000000000002',
  relayerAddress: privateKeyToAccount(relayerPrivateKey).address.toLowerCase() as Hex
};

const requirement: PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:84532',
  asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
  payTo: '0x0000000000000000000000000000000000000002',
  rail: 'shielded-usdc',
  amount: '10',
  challengeNonce: '0x9999999999999999999999999999999999999999999999999999999999999999',
  challengeExpiry: String(Math.floor(Date.now() / 1000) + 600),
  merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
  verifyingContract: '0x0000000000000000000000000000000000000002'
};

async function signRelayerState(state: CreditState): Promise<Hex> {
  const relayer = privateKeyToAccount(relayerPrivateKey);
  const signature = await relayer.signTypedData({
    domain: toEip712Domain(domain),
    types: CREDIT_EIP712_TYPES,
    primaryType: 'CreditState',
    message: toCreditStateTypedData(state)
  });
  return signature.toLowerCase() as Hex;
}

async function signAgentState(state: CreditState): Promise<Hex> {
  const agent = privateKeyToAccount(agentPrivateKey);
  const signature = await agent.signTypedData({
    domain: toEip712Domain(domain),
    types: CREDIT_EIP712_TYPES,
    primaryType: 'CreditState',
    message: toCreditStateTypedData(state)
  });
  return signature.toLowerCase() as Hex;
}

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe('createCreditChannelClient', () => {
  it('persists topup nextState after verifying relayer signature', async () => {
    const agent = privateKeyToAccount(agentPrivateKey);
    const derivedChannelId = deriveCreditChannelId({
      domain,
      agentAddress: agent.address.toLowerCase() as Hex
    });
    let persisted: SignedCreditState | undefined;
    const stateStore = {
      getCreditState: () => persisted,
      setCreditState: async (state: SignedCreditState) => {
        persisted = state;
      }
    };

    const nextState: CreditState = {
      channelId: derivedChannelId,
      seq: '0',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: '1700000000',
      agentAddress: agent.address.toLowerCase() as Hex,
      relayerAddress: domain.relayerAddress
    };
    const nextStateRelayerSignature = await signRelayerState(nextState);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/relay/credit/domain')) {
        return new Response(JSON.stringify(domain), { status: 200 });
      }
      if (url.endsWith('/v1/relay/credit/topup')) {
        return new Response(
          JSON.stringify({
            requestId: 'topup-1',
            status: 'DONE',
            channelId: nextState.channelId,
            nextState,
            nextStateRelayerSignature
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const client = createCreditChannelClient({
      relayerEndpoint: 'http://relayer.local',
      agentAddress: agent.address as Hex,
      signer: {
        signTypedData: (args) => agent.signTypedData(args)
      },
      stateStore,
      fetchImpl: asFetch(fetchMock)
    });

    const result = await client.topup({
      requestId: 'topup-1',
      paymentPayload: {
        proof: '0x1234',
        publicInputs: [
          '0x1',
          '0x2',
          '0x3',
          '0x4',
          '0x5',
          '0x64'
        ],
        nullifier: '0x0000000000000000000000000000000000000000000000000000000000000001',
        root: '0x0000000000000000000000000000000000000000000000000000000000000002',
        merchantCommitment:
          '0x0000000000000000000000000000000000000000000000000000000000000003',
        changeCommitment:
          '0x0000000000000000000000000000000000000000000000000000000000000004',
        challengeHash:
          '0x0000000000000000000000000000000000000000000000000000000000000005',
        encryptedReceipt:
          '0x0000000000000000000000000000000000000000000000000000000000000006'
      },
      paymentPayloadSignature:
        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b'
    });

    expect(result.status).toBe('DONE');
    expect(await client.getChannelId()).toBe(derivedChannelId);
    expect(persisted?.state.seq).toBe('0');
  });

  it('serializes concurrent pay calls and advances latestState sequentially', async () => {
    const agent = privateKeyToAccount(agentPrivateKey);
    const initialState: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '0',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: '1700000000',
      agentAddress: agent.address.toLowerCase() as Hex,
      relayerAddress: domain.relayerAddress
    };

    let persisted: SignedCreditState = {
      state: initialState,
      agentSignature: await signAgentState(initialState),
      relayerSignature: await signRelayerState(initialState)
    };

    let payCalls = 0;
    const seenLatestSeq: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/relay/credit/domain')) {
        return new Response(JSON.stringify(domain), { status: 200 });
      }
      if (url.endsWith('/v1/relay/credit/pay')) {
        payCalls += 1;
        const parsed = JSON.parse(String(init?.body)) as {
          latestState: { state: CreditState };
        };
        seenLatestSeq.push(parsed.latestState.state.seq);
        const nextSeq = (BigInt(parsed.latestState.state.seq) + 1n).toString();
        const nextAvailable = (BigInt(parsed.latestState.state.available) - 10n).toString();
        const nextState: CreditState = {
          ...parsed.latestState.state,
          seq: nextSeq,
          available: nextAvailable,
          cumulativeSpent: (BigInt(parsed.latestState.state.cumulativeSpent) + 10n).toString(),
          lastDebitDigest:
            '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
        };
        const nextStateRelayerSignature = await signRelayerState(nextState);
        if (payCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return new Response(
          JSON.stringify({
            requestId: `pay-${payCalls}`,
            status: 'DONE',
            channelId: nextState.channelId,
            nextState,
            nextStateRelayerSignature,
            merchantResult: {
              status: 200,
              headers: {},
              bodyBase64: Buffer.from('{}', 'utf8').toString('base64')
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const stateStore = {
      getCreditState: () => persisted,
      setCreditState: async (state: SignedCreditState) => {
        persisted = state;
      }
    };

    const client = createCreditChannelClient({
      relayerEndpoint: 'http://relayer.local',
      channelId: initialState.channelId as Hex,
      agentAddress: agent.address as Hex,
      signer: {
        signTypedData: (args) => agent.signTypedData(args)
      },
      stateStore,
      fetchImpl: asFetch(fetchMock)
    });

    const merchantRequest = {
      url: 'https://merchant.example/paid',
      method: 'GET'
    };

    const [a, b] = await Promise.all([
      client.pay({ requestId: 'credit-pay-a', merchantRequest, requirement }),
      client.pay({ requestId: 'credit-pay-b', merchantRequest, requirement })
    ]);

    expect(a.status).toBe('DONE');
    expect(b.status).toBe('DONE');
    expect(seenLatestSeq).toEqual(['0', '1']);
    expect(persisted.state.seq).toBe('2');
    expect(persisted.state.available).toBe('80');
  });
});
