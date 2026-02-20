import { describe, expect, it } from 'vitest';
import { ShieldedMerchantSDK } from './merchant.js';
import { privateKeyToAccount } from 'viem/accounts';
import { concatHex, keccak256 } from 'viem';
import {
  challengeHashPreimage,
  buildPaymentSignatureHeader,
  normalizeRequirement
} from '@shielded-x402/shared-types';

describe('ShieldedMerchantSDK', () => {
  it('issues challenge and rejects missing headers', async () => {
    const sdk = new ShieldedMerchantSDK(
      {
        rail: 'shielded-usdc',
        price: 10n,
        merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        verifyingContract: '0x0000000000000000000000000000000000000002',
        challengeTtlMs: 10000,
        now: () => 1_000_000
      },
      {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      }
    );

    const issued = sdk.issue402();
    expect(issued.requirement.rail).toBe('shielded-usdc');

    const result = await sdk.verifyShieldedPayment(null);
    expect(result.ok).toBe(false);
  });

  it('rejects challenge hash mismatch', async () => {
    const account = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0'
    );

    const sdk = new ShieldedMerchantSDK(
      {
        rail: 'shielded-usdc',
        price: 10n,
        merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        verifyingContract: '0x0000000000000000000000000000000000000002',
        challengeTtlMs: 10000,
        now: () => 1_000_000
      },
      {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      }
    );

    const issued = sdk.issue402();
    const payload = {
      proof: '0x00',
      publicInputs: [
        '0x0000000000000000000000000000000000000000000000000000000000000011',
        '0x0000000000000000000000000000000000000000000000000000000000000022',
        '0x0000000000000000000000000000000000000000000000000000000000000033',
        '0x0000000000000000000000000000000000000000000000000000000000000044',
        '0x0000000000000000000000000000000000000000000000000000000000000055',
        '0xa'
      ],
      nullifier: '0x0000000000000000000000000000000000000000000000000000000000000011',
      root: '0x0000000000000000000000000000000000000000000000000000000000000022',
      merchantCommitment:
        '0x0000000000000000000000000000000000000000000000000000000000000033',
      changeCommitment:
        '0x0000000000000000000000000000000000000000000000000000000000000044',
      challengeHash:
        '0x0000000000000000000000000000000000000000000000000000000000000055',
      encryptedReceipt: '0x'
    };

    const raw = JSON.stringify(payload);
    const signature = await account.signMessage({ message: raw });
    const paymentSignatureHeader = buildPaymentSignatureHeader({
      x402Version: 2,
      accepted: normalizeRequirement(issued.requirement),
      payload,
      challengeNonce: issued.requirement.challengeNonce as `0x${string}`,
      signature
    });
    const result = await sdk.verifyShieldedPayment(paymentSignatureHeader);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('challenge hash mismatch');
  });

  it('accepts valid payload once and rejects replay via nullifier hook', async () => {
    const account = privateKeyToAccount(
      '0x8b3a350cf5c34c9194ca3a545d0d36987d5c3f8a2ad542ef898f4f6f8a9f0d40'
    );
    const seen = new Set<string>();
    const now = () => 1_000_000;

    const sdk = new ShieldedMerchantSDK(
      {
        rail: 'shielded-usdc',
        price: 10n,
        merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        verifyingContract: '0x0000000000000000000000000000000000000002',
        challengeTtlMs: 10000,
        now
      },
      {
        verifyProof: async () => true,
        isNullifierUsed: async (nullifier) => seen.has(nullifier)
      }
    );

    const issued = sdk.issue402();
    const challengeHash = keccak256(
      concatHex(
        challengeHashPreimage(
          issued.requirement.challengeNonce as `0x${string}`,
          10n,
          '0x0000000000000000000000000000000000000002'
        )
      )
    );

    const payload = {
      proof: '0x00',
      publicInputs: [
        '0x0000000000000000000000000000000000000000000000000000000000000011',
        '0x0000000000000000000000000000000000000000000000000000000000000022',
        '0x0000000000000000000000000000000000000000000000000000000000000033',
        '0x0000000000000000000000000000000000000000000000000000000000000044',
        challengeHash,
        '0xa'
      ],
      nullifier: '0x0000000000000000000000000000000000000000000000000000000000000011',
      root: '0x0000000000000000000000000000000000000000000000000000000000000022',
      merchantCommitment:
        '0x0000000000000000000000000000000000000000000000000000000000000033',
      changeCommitment:
        '0x0000000000000000000000000000000000000000000000000000000000000044',
      challengeHash,
      encryptedReceipt: '0x'
    };

    const raw = JSON.stringify(payload);
    const signature = await account.signMessage({ message: raw });
    const paymentSignatureHeader = buildPaymentSignatureHeader({
      x402Version: 2,
      accepted: normalizeRequirement(issued.requirement),
      payload,
      challengeNonce: issued.requirement.challengeNonce as `0x${string}`,
      signature
    });
    const first = await sdk.verifyShieldedPayment(paymentSignatureHeader);
    expect(first.ok).toBe(true);

    seen.add(payload.nullifier);
    const second = await sdk.verifyShieldedPayment(paymentSignatureHeader);
    expect(second.ok).toBe(false);
  });

  it('creates withdraw calldata payload', async () => {
    const sdk = new ShieldedMerchantSDK(
      {
        rail: 'shielded-usdc',
        price: 10n,
        merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        verifyingContract: '0x0000000000000000000000000000000000000002',
        challengeTtlMs: 10000,
        now: () => 1_000_000
      },
      {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      }
    );

    const result = await sdk.decryptAndWithdraw({
      nullifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      challengeNonce: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      recipient: '0x0000000000000000000000000000000000000009'
    });

    expect(result.encodedCallData.startsWith('0x')).toBe(true);
    expect(result.nullifier).toBe(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(result.challengeNonce).toBe(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
  });
});
