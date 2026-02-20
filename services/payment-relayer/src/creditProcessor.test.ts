import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CREDIT_EIP712_NAME,
  CREDIT_EIP712_TYPES,
  CREDIT_EIP712_VERSION,
  canonicalMerchantRequestHash,
  hashCreditState,
  toCreditDebitIntentTypedData,
  toCreditStateTypedData,
  toEip712Domain,
  type CreditDebitIntent,
  type CreditDomainResponse,
  type CreditState,
  type Hex,
  type PaymentRequirement,
  type ShieldedPaymentResponse
} from '@shielded-x402/shared-types';
import { createCreditRelayerProcessor } from './creditProcessor.js';

const relayerPrivateKey =
  '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0' as Hex;
const agentPrivateKey =
  '0x8b3a350cf5c34c9194ca3a545d83a16b5d2d1f8f907f4f7b2f5f1f5a8e8e8e8e' as Hex;

function makeDomain(): CreditDomainResponse {
  return {
    name: CREDIT_EIP712_NAME,
    version: CREDIT_EIP712_VERSION,
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

async function signState(domain: CreditDomainResponse, state: CreditState): Promise<{
  agentSignature: Hex;
  relayerSignature: Hex;
}> {
  const agent = privateKeyToAccount(agentPrivateKey);
  const relayer = privateKeyToAccount(relayerPrivateKey);
  const typedDomain = toEip712Domain(domain);
  const message = toCreditStateTypedData(state);
  const agentSignature = await agent.signTypedData({
    domain: typedDomain,
    types: CREDIT_EIP712_TYPES,
    primaryType: 'CreditState',
    message
  });
  const relayerSignature = await relayer.signTypedData({
    domain: typedDomain,
    types: CREDIT_EIP712_TYPES,
    primaryType: 'CreditState',
    message
  });
  return {
    agentSignature: agentSignature.toLowerCase() as Hex,
    relayerSignature: relayerSignature.toLowerCase() as Hex
  };
}

async function signIntent(domain: CreditDomainResponse, intent: CreditDebitIntent): Promise<Hex> {
  const agent = privateKeyToAccount(agentPrivateKey);
  const signature = await agent.signTypedData({
    domain: toEip712Domain(domain),
    types: CREDIT_EIP712_TYPES,
    primaryType: 'CreditDebitIntent',
    message: toCreditDebitIntentTypedData(intent)
  });
  return signature.toLowerCase() as Hex;
}

function makePaymentPayload(nullifier: Hex, amountHex: Hex = '0x28'): ShieldedPaymentResponse {
  return {
    proof: '0x1234',
    publicInputs: ['0x1', '0x2', '0x3', '0x4', '0x5', amountHex],
    nullifier,
    root: '0x1111111111111111111111111111111111111111111111111111111111111111',
    merchantCommitment:
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    changeCommitment:
      '0x3333333333333333333333333333333333333333333333333333333333333333',
    challengeHash:
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    encryptedReceipt:
      '0x5555555555555555555555555555555555555555555555555555555555555555'
  };
}

async function signPaymentPayload(payload: ShieldedPaymentResponse): Promise<Hex> {
  const agent = privateKeyToAccount(agentPrivateKey);
  const signature = await agent.signMessage({
    message: JSON.stringify(payload)
  });
  return signature.toLowerCase() as Hex;
}

describe('credit relayer processor', () => {
  it('processes pay request and returns next state', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '4',
      available: '100',
      cumulativeSpent: '10',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = {
      url: 'https://merchant.example/paid?a=1&b=2',
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash:
        '0x066f953e8f7884dd31ec25f0a5bfdd106f79d8e12878dfef131f3becfb4d6f07',
      nextSeq: '5',
      amount: '40',
      merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
      deadline: String(Math.floor(Date.now() / 1000) + 120),
      requestId: 'credit-req-1'
    };
    // prevStateHash is checked against hashCreditState in processor; use runtime value.
    debitIntent.prevStateHash = hashCreditState(current);
    const debitIntentSignature = await signIntent(domain, debitIntent);

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
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const result = await processor.handlePay({
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: {
        state: current,
        ...signatures
      },
      debitIntent,
      debitIntentSignature
    });

    expect(result.status).toBe('DONE');
    expect(result.nextState?.seq).toBe('5');
    expect(result.nextState?.available).toBe('60');
    expect(result.nextStateRelayerSignature).toMatch(/^0x[0-9a-f]+$/);
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('rejects stale sequence and does not call payout', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '7',
      available: '100',
      cumulativeSpent: '10',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = {
      url: 'https://merchant.example/paid',
      method: 'GET'
    };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash: hashCreditState(current),
      nextSeq: '7',
      amount: '40',
      merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
      deadline: String(Math.floor(Date.now() / 1000) + 120),
      requestId: 'credit-req-stale'
    };
    const debitIntentSignature = await signIntent(domain, debitIntent);

    const payout = {
      payMerchant: vi.fn()
    };

    const processor = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const result = await processor.handlePay({
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: {
        state: current,
        ...signatures
      },
      debitIntent,
      debitIntentSignature
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toContain('nextSeq');
    expect(payout.payMerchant).not.toHaveBeenCalled();
  });

  it('serializes concurrent debits per channel and rejects stale second request', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '4',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = {
      url: 'https://merchant.example/paid',
      method: 'GET'
    };

    const makeRequest = async (requestId: string) => {
      const debitIntent: CreditDebitIntent = {
        channelId: current.channelId,
        prevStateHash: hashCreditState(current),
        nextSeq: '5',
        amount: '40',
        merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
        deadline: String(Math.floor(Date.now() / 1000) + 120),
        requestId
      };
      const debitIntentSignature = await signIntent(domain, debitIntent);
      return {
        requestId,
        merchantRequest,
        requirement,
        latestState: {
          state: current,
          ...signatures
        },
        debitIntent,
        debitIntentSignature
      };
    };

    const reqA = await makeRequest('credit-race-a');
    const reqB = await makeRequest('credit-race-b');

    const payout = {
      payMerchant: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          status: 200,
          headers: {},
          bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
        };
      })
    };

    const processor = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const [resA, resB] = await Promise.all([processor.handlePay(reqA), processor.handlePay(reqB)]);
    const results = [resA, resB];
    const done = results.filter((result) => result.status === 'DONE');
    const failed = results.filter((result) => result.status === 'FAILED');

    expect(done).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failureReason ?? '').toContain('stale latestState');
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('supports close start/challenge/finalize when settlement adapter is configured', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const state: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '9',
      available: '55',
      cumulativeSpent: '45',
      lastDebitDigest: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, state);

    const creditSettlement = {
      openOrTopup: vi.fn(async () => ({
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex
      })),
      startClose: vi.fn(async () => ({
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex,
        challengeDeadline: 12345n
      })),
      challengeClose: vi.fn(async () => ({
        txHash: '0x3333333333333333333333333333333333333333333333333333333333333333' as Hex,
        challengeDeadline: 23456n
      })),
      finalizeClose: vi.fn(async () => ({
        txHash: '0x4444444444444444444444444444444444444444444444444444444444444444' as Hex,
        paidToAgent: 55n,
        paidToRelayer: 45n
      })),
      getChannel: vi.fn(async () => ({
        channelId: state.channelId,
        exists: true,
        closing: true,
        agentAddress: state.agentAddress,
        relayerAddress: state.relayerAddress,
        escrowed: '100',
        closeSeq: state.seq,
        challengeDeadline: '99999',
        closeAvailable: state.available,
        closeCumulativeSpent: state.cumulativeSpent,
        closeLastDebitDigest: state.lastDebitDigest,
        closeUpdatedAt: state.updatedAt
      }))
    };

    const processor = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout: {
        payMerchant: async () => ({
          status: 200,
          headers: {},
          bodyBase64: Buffer.from('{}', 'utf8').toString('base64')
        })
      },
      creditSettlement,
      creditDomain: domain,
      relayerPrivateKey
    });

    const started = await processor.handleCloseStart({
      latestState: {
        state,
        ...signatures
      }
    });
    expect(started.status).toBe('DONE');
    expect(started.challengeDeadline).toBe('12345');
    expect(creditSettlement.startClose).toHaveBeenCalledTimes(1);

    const challenged = await processor.handleCloseChallenge({
      higherState: {
        state: {
          ...state,
          seq: '10'
        },
        ...(await signState(domain, { ...state, seq: '10' }))
      }
    });
    expect(challenged.status).toBe('DONE');
    expect(challenged.challengeDeadline).toBe('23456');
    expect(creditSettlement.challengeClose).toHaveBeenCalledTimes(1);

    const finalized = await processor.handleCloseFinalize({
      channelId: state.channelId
    });
    expect(finalized.status).toBe('DONE');
    expect(finalized.paidToAgent).toBe('55');
    expect(finalized.paidToRelayer).toBe('45');
    expect(creditSettlement.finalizeClose).toHaveBeenCalledTimes(1);

    const status = await processor.getCloseStatus(state.channelId);
    expect(status.exists).toBe(true);
    expect(status.closeSeq).toBe('9');
  });

  it('rejects stale state after relayer restart when head store persists channel head', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '4',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = {
      url: 'https://merchant.example/paid',
      method: 'GET'
    };

    const makeDebit = async (requestId: string, latestState: CreditState) => {
      const debitIntent: CreditDebitIntent = {
        channelId: latestState.channelId,
        prevStateHash: hashCreditState(latestState),
        nextSeq: (BigInt(latestState.seq) + 1n).toString(),
        amount: '40',
        merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
        deadline: String(Math.floor(Date.now() / 1000) + 120),
        requestId
      };
      const debitIntentSignature = await signIntent(domain, debitIntent);
      return {
        requestId,
        merchantRequest,
        requirement,
        latestState: {
          state: latestState,
          ...(await signState(domain, latestState))
        },
        debitIntent,
        debitIntentSignature
      };
    };

    const payout = {
      payMerchant: vi.fn(async () => ({
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
      }))
    };

    const persistedHeads = new Map<string, CreditState>();
    const headStore = {
      get: vi.fn(async (channelId: Hex) => persistedHeads.get(channelId.toLowerCase())),
      put: vi.fn(async (state: CreditState) => {
        persistedHeads.set(state.channelId.toLowerCase(), state);
      }),
      delete: vi.fn(async (channelId: Hex) => {
        persistedHeads.delete(channelId.toLowerCase());
      })
    };

    const firstRelayer = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout,
      headStore,
      creditDomain: domain,
      relayerPrivateKey
    });

    const firstReq = await makeDebit('credit-restart-1', current);
    const firstResult = await firstRelayer.handlePay({
      ...firstReq,
      latestState: {
        state: current,
        ...signatures
      }
    });
    expect(firstResult.status).toBe('DONE');
    expect(firstResult.nextState?.seq).toBe('5');

    const secondRelayer = createCreditRelayerProcessor({
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      },
      payout,
      headStore,
      creditDomain: domain,
      relayerPrivateKey
    });

    const staleReq = await makeDebit('credit-restart-2', current);
    const staleResult = await secondRelayer.handlePay(staleReq);
    expect(staleResult.status).toBe('FAILED');
    expect(staleResult.failureReason ?? '').toContain('stale latestState');
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('rejects overspend debit and does not call payout', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '1',
      available: '30',
      cumulativeSpent: '20',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = { url: 'https://merchant.example/paid', method: 'GET' };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash: hashCreditState(current),
      nextSeq: '2',
      amount: '40',
      merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
      deadline: String(Math.floor(Date.now() / 1000) + 120),
      requestId: 'credit-overspend'
    };
    const debitIntentSignature = await signIntent(domain, debitIntent);
    const payout = { payMerchant: vi.fn() };

    const processor = createCreditRelayerProcessor({
      verifier: { verifyProof: async () => true, isNullifierUsed: async () => false },
      settlement: { settleOnchain: async () => ({ alreadySettled: false }) },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const result = await processor.handlePay({
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: { state: current, ...signatures },
      debitIntent,
      debitIntentSignature
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason ?? '').toContain('insufficient channel credit');
    expect(payout.payMerchant).not.toHaveBeenCalled();
  });

  it('rejects expired deadline', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '2',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = { url: 'https://merchant.example/paid', method: 'GET' };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash: hashCreditState(current),
      nextSeq: '3',
      amount: '40',
      merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
      deadline: String(Math.floor(Date.now() / 1000) - 1),
      requestId: 'credit-expired'
    };
    const debitIntentSignature = await signIntent(domain, debitIntent);
    const payout = { payMerchant: vi.fn() };

    const processor = createCreditRelayerProcessor({
      verifier: { verifyProof: async () => true, isNullifierUsed: async () => false },
      settlement: { settleOnchain: async () => ({ alreadySettled: false }) },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const result = await processor.handlePay({
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: { state: current, ...signatures },
      debitIntent,
      debitIntentSignature
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason ?? '').toContain('expired');
    expect(payout.payMerchant).not.toHaveBeenCalled();
  });

  it('rejects merchantRequestHash mismatch', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '3',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = { url: 'https://merchant.example/paid', method: 'GET' };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash: hashCreditState(current),
      nextSeq: '4',
      amount: '40',
      merchantRequestHash:
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      deadline: String(Math.floor(Date.now() / 1000) + 120),
      requestId: 'credit-hash-mismatch'
    };
    const debitIntentSignature = await signIntent(domain, debitIntent);
    const payout = { payMerchant: vi.fn() };

    const processor = createCreditRelayerProcessor({
      verifier: { verifyProof: async () => true, isNullifierUsed: async () => false },
      settlement: { settleOnchain: async () => ({ alreadySettled: false }) },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const result = await processor.handlePay({
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: { state: current, ...signatures },
      debitIntent,
      debitIntentSignature
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureReason ?? '').toContain('merchantRequestHash mismatch');
    expect(payout.payMerchant).not.toHaveBeenCalled();
  });

  it('returns cached pay response for duplicate requestId', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '4',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);
    const requirement = makeRequirement('40');
    const merchantRequest = { url: 'https://merchant.example/paid', method: 'GET' };
    const debitIntent: CreditDebitIntent = {
      channelId: current.channelId,
      prevStateHash: hashCreditState(current),
      nextSeq: '5',
      amount: '40',
      merchantRequestHash: canonicalMerchantRequestHash({ merchantRequest, requirement }),
      deadline: String(Math.floor(Date.now() / 1000) + 120),
      requestId: 'credit-idempotent-pay'
    };
    const debitIntentSignature = await signIntent(domain, debitIntent);
    const payout = {
      payMerchant: vi.fn(async () => ({
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64')
      }))
    };

    const processor = createCreditRelayerProcessor({
      verifier: { verifyProof: async () => true, isNullifierUsed: async () => false },
      settlement: { settleOnchain: async () => ({ alreadySettled: false }) },
      payout,
      creditDomain: domain,
      relayerPrivateKey
    });

    const request = {
      requestId: debitIntent.requestId,
      merchantRequest,
      requirement,
      latestState: { state: current, ...signatures },
      debitIntent,
      debitIntentSignature
    };

    const first = await processor.handlePay(request);
    const second = await processor.handlePay(request);

    expect(first.status).toBe('DONE');
    expect(second).toEqual(first);
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent topups and rejects stale second topup', async () => {
    const domain = makeDomain();
    const agentAddress = privateKeyToAccount(agentPrivateKey).address.toLowerCase() as Hex;
    const current: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '4',
      available: '100',
      cumulativeSpent: '0',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: String(Math.floor(Date.now() / 1000)),
      agentAddress,
      relayerAddress: domain.relayerAddress
    };
    const signatures = await signState(domain, current);

    const payloadA = makePaymentPayload(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0x10'
    );
    const payloadB = makePaymentPayload(
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      '0x10'
    );
    const signatureA = await signPaymentPayload(payloadA);
    const signatureB = await signPaymentPayload(payloadB);

    const settlement = {
      settleOnchain: vi.fn(async () => ({ alreadySettled: false }))
    };
    const processor = createCreditRelayerProcessor({
      verifier: { verifyProof: async () => true, isNullifierUsed: async () => false },
      settlement,
      payout: {
        payMerchant: async () => ({
          status: 200,
          headers: {},
          bodyBase64: Buffer.from('{}', 'utf8').toString('base64')
        })
      },
      creditDomain: domain,
      relayerPrivateKey
    });

    const [topupA, topupB] = await Promise.all([
      processor.handleTopup({
        channelId: current.channelId,
        requestId: 'credit-topup-race-a',
        paymentPayload: payloadA,
        paymentPayloadSignature: signatureA,
        latestState: { state: current, ...signatures }
      }),
      processor.handleTopup({
        channelId: current.channelId,
        requestId: 'credit-topup-race-b',
        paymentPayload: payloadB,
        paymentPayloadSignature: signatureB,
        latestState: { state: current, ...signatures }
      })
    ]);

    const done = [topupA, topupB].filter((result) => result.status === 'DONE');
    const failed = [topupA, topupB].filter((result) => result.status === 'FAILED');

    expect(done).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failureReason ?? '').toContain('stale latestState');
    expect(settlement.settleOnchain).toHaveBeenCalledTimes(1);
  });
});
