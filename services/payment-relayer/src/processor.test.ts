import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  concatHex,
  keccak256,
  pad,
  type Hex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRYPTO_SPEC,
  buildPaymentSignatureHeader,
  normalizeRequirement,
  type PaymentRequirement,
  type RelayerPayRequest
} from '@shielded-x402/shared-types';
import { createPaymentRelayerProcessor } from './processor.js';
import { FileSettlementStore } from './store.js';

function challengeHash(requirement: PaymentRequirement): Hex {
  const amountWord = (`0x${BigInt(requirement.amount).toString(16).padStart(64, '0')}` as Hex);
  const merchantWord = pad(requirement.verifyingContract, { size: 32 });
  return keccak256(
    concatHex([
      CRYPTO_SPEC.challengeDomainHash as Hex,
      requirement.challengeNonce as Hex,
      amountWord,
      merchantWord
    ])
  );
}

function makeRequirement(): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'eip155:11155111',
    asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
    payTo: '0x0000000000000000000000000000000000000002',
    rail: 'shielded-usdc',
    amount: '40',
    challengeNonce:
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    challengeExpiry: String(Date.now() + 120_000),
    merchantPubKey:
      '0x0000000000000000000000000000000000000000000000000000000000000012',
    verifyingContract: '0x0000000000000000000000000000000000000002'
  };
}

function makePayload(requirement: PaymentRequirement) {
  const hash = challengeHash(requirement);
  return {
    proof: '0x1234' as Hex,
    publicInputs: [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444444444444444444444444444',
      hash,
      '0x0000000000000000000000000000000000000000000000000000000000000028'
    ] as Hex[],
    nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
    root: '0x2222222222222222222222222222222222222222222222222222222222222222',
    merchantCommitment: '0x3333333333333333333333333333333333333333333333333333333333333333',
    changeCommitment: '0x4444444444444444444444444444444444444444444444444444444444444444',
    challengeHash: hash,
    encryptedReceipt: '0x'
  };
}

async function makeRequest(requirement: PaymentRequirement): Promise<RelayerPayRequest> {
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0'
  );
  const payload = makePayload(requirement);
  const signedPayload = JSON.stringify(payload);
  const paymentSignature = await account.signMessage({ message: signedPayload });
  const paymentSignatureHeader = buildPaymentSignatureHeader({
    x402Version: 2,
    accepted: normalizeRequirement(requirement),
    payload,
    challengeNonce: requirement.challengeNonce as Hex,
    signature: paymentSignature
  });

  return {
    merchantRequest: {
      url: 'http://merchant.example/paid',
      method: 'GET',
      challengeUrl: 'http://merchant.example/x402/requirement'
    },
    requirement,
    paymentSignatureHeader
  };
}

const tempFiles: string[] = [];

function tempStorePath(): string {
  const file = join(tmpdir(), `shielded-relayer-test-${randomBytes(6).toString('hex')}.json`);
  tempFiles.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(
    tempFiles.splice(0).map(async (file) => {
      await rm(file, { force: true });
    })
  );
});

describe('payment relayer processor', () => {
  it('processes verify -> settle -> payout -> done', async () => {
    const requirement = makeRequirement();
    const request = await makeRequest(requirement);

    const verifier = {
      verifyProof: vi.fn(async () => true),
      isNullifierUsed: vi.fn(async () => false)
    };
    const settlement = {
      settleOnchain: vi.fn(async () => ({ alreadySettled: false, txHash: '0xabc' as Hex }))
    };
    const payout = {
      payMerchant: vi.fn(async () => ({ status: 200, headers: {}, body: '{"ok":true}' }))
    };
    const challengeFetcher = {
      fetchRequirement: vi.fn(async () => requirement)
    };

    const processor = createPaymentRelayerProcessor({
      store: new FileSettlementStore(tempStorePath()),
      verifier,
      settlement,
      payout,
      challengeFetcher
    });

    const result = await processor.handlePay(request);
    expect(result.status).toBe('DONE');
    expect(result.settlementTxHash).toBe('0xabc');
    expect(result.merchantResult?.status).toBe(200);
    expect(verifier.verifyProof).toHaveBeenCalledTimes(1);
    expect(settlement.settleOnchain).toHaveBeenCalledTimes(1);
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for duplicate request payloads', async () => {
    const requirement = makeRequirement();
    const request = await makeRequest(requirement);

    const settlement = {
      settleOnchain: vi.fn(async () => ({ alreadySettled: false, txHash: '0xabc' as Hex }))
    };
    const payout = {
      payMerchant: vi.fn(async () => ({ status: 200, headers: {}, body: '{"ok":true}' }))
    };

    const processor = createPaymentRelayerProcessor({
      store: new FileSettlementStore(tempStorePath()),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement,
      payout,
      challengeFetcher: {
        fetchRequirement: async () => requirement
      }
    });

    const first = await processor.handlePay(request);
    const second = await processor.handlePay(request);

    expect(first.settlementId).toBe(second.settlementId);
    expect(second.status).toBe('DONE');
    expect(settlement.settleOnchain).toHaveBeenCalledTimes(1);
    expect(payout.payMerchant).toHaveBeenCalledTimes(1);
  });

  it('fails on challenge mismatch without settlement', async () => {
    const requirement = makeRequirement();
    const request = await makeRequest(requirement);
    const mismatch = {
      ...requirement,
      amount: '41'
    };

    const settlement = {
      settleOnchain: vi.fn(async () => ({ alreadySettled: false, txHash: '0xabc' as Hex }))
    };

    const processor = createPaymentRelayerProcessor({
      store: new FileSettlementStore(tempStorePath()),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement,
      payout: {
        payMerchant: async () => ({ status: 200, headers: {}, body: '{"ok":true}' })
      },
      challengeFetcher: {
        fetchRequirement: async () => mismatch
      }
    });

    const result = await processor.handlePay(request);
    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toContain('merchant challenge mismatch');
    expect(settlement.settleOnchain).not.toHaveBeenCalled();
  });
});
