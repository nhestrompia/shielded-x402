import { describe, expect, it } from 'vitest';
import { CRYPTO_SPEC } from './crypto-spec.js';
import {
  canonicalMerchantRequestHash,
  deriveCreditChannelId,
  hashCreditDebitIntent,
  hashCreditState
} from './credit.js';
import { challengeHashPreimage, toHexWord } from './crypto.js';
import { validateShieldedPaymentResponseShape } from './shielded.js';

describe('CRYPTO_SPEC', () => {
  it('locks expected tree depth', () => {
    expect(CRYPTO_SPEC.merkleTreeDepth).toBe(24);
  });
});

describe('credit canonical hashing', () => {
  it('normalizes merchant request URL and header order', () => {
    const requirement = {
      scheme: 'exact',
      network: 'EIP155:84532',
      asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
      payTo: '0x0000000000000000000000000000000000000001',
      rail: 'shielded-usdc',
      amount: '10000',
      challengeNonce:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      challengeExpiry: '1735689600',
      merchantPubKey:
        '0x0000000000000000000000000000000000000000000000000000000000000009',
      verifyingContract: '0x0000000000000000000000000000000000000002'
    } as const;

    const a = canonicalMerchantRequestHash({
      merchantRequest: {
        url: 'HTTPS://Example.COM:443/paid?b=2&a=1',
        method: 'post',
        headers: { 'Content-Type': ' application/json ', Accept: 'application/json' },
        bodyBase64: Buffer.from('{"hello":"world"}', 'utf8').toString('base64')
      },
      requirement
    });
    const b = canonicalMerchantRequestHash({
      merchantRequest: {
        url: 'https://example.com/paid?a=1&b=2',
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"hello":"world"}', 'utf8').toString('base64')
      },
      requirement
    });

    expect(a).toBe(b);
  });

  it('derives deterministic channel id from domain + agent', () => {
    const domain = {
      name: 'shielded-x402-credit',
      version: '1',
      chainId: 84532,
      verifyingContract: '0x0000000000000000000000000000000000000002',
      relayerAddress: '0x0000000000000000000000000000000000000004'
    } as const;
    const agentAddress = '0x0000000000000000000000000000000000000003' as const;
    const a = deriveCreditChannelId({ domain, agentAddress });
    const b = deriveCreditChannelId({ domain, agentAddress });
    const c = deriveCreditChannelId({
      domain: { ...domain, relayerAddress: '0x0000000000000000000000000000000000000005' },
      agentAddress
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c).not.toBe(a);
  });

  it('hashes credit state and debit intent deterministically', () => {
    const state = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '5',
      available: '9900',
      cumulativeSpent: '100',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: '1735689600',
      agentAddress: '0x0000000000000000000000000000000000000003',
      relayerAddress: '0x0000000000000000000000000000000000000004'
    } as const;
    const stateHash = hashCreditState(state);
    const debitHash = hashCreditDebitIntent({
      channelId: state.channelId,
      prevStateHash: stateHash,
      nextSeq: '6',
      amount: '25',
      merchantRequestHash:
        '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      deadline: '1735689700',
      requestId: 'credit-request-1'
    });

    expect(stateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(debitHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('shared crypto helpers', () => {
  it('toHexWord encodes 32-byte words', () => {
    expect(toHexWord(10n)).toBe('0x000000000000000000000000000000000000000000000000000000000000000a');
  });

  it('builds challenge hash preimage components deterministically', () => {
    const preimageA = challengeHashPreimage(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      10000n,
      '0x0000000000000000000000000000000000000002'
    );
    const preimageB = challengeHashPreimage(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      10000n,
      '0x0000000000000000000000000000000000000002'
    );
    expect(preimageA).toEqual(preimageB);
    expect(preimageA[2]).toBe('0x0000000000000000000000000000000000000000000000000000000000002710');
    expect(preimageA[3]).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
  });
});

describe('shielded payload validation', () => {
  it('accepts valid 6-input payload shape', () => {
    const payload = {
      proof: '0x12',
      publicInputs: [
        '0x01',
        '0x02',
        '0x03',
        '0x04',
        '0x05',
        '0x06'
      ],
      nullifier: '0x' + '11'.repeat(32),
      root: '0x' + '22'.repeat(32),
      merchantCommitment: '0x' + '33'.repeat(32),
      changeCommitment: '0x' + '44'.repeat(32),
      challengeHash: '0x' + '55'.repeat(32),
      encryptedReceipt: '0x99'
    };
    expect(
      validateShieldedPaymentResponseShape(payload, {
        exactPublicInputsLength: 6,
        maxProofHexLength: 262144
      })
    ).toBeUndefined();
  });

  it('rejects invalid public input length', () => {
    const payload = {
      proof: '0x12',
      publicInputs: ['0x01'],
      nullifier: '0x' + '11'.repeat(32),
      root: '0x' + '22'.repeat(32),
      merchantCommitment: '0x' + '33'.repeat(32),
      changeCommitment: '0x' + '44'.repeat(32),
      challengeHash: '0x' + '55'.repeat(32),
      encryptedReceipt: '0x99'
    };
    expect(validateShieldedPaymentResponseShape(payload, { exactPublicInputsLength: 6 })).toBe(
      'invalid public input length'
    );
  });
});
