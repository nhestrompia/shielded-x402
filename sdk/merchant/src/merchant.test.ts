import { describe, expect, it } from 'vitest';
import { ShieldedMerchantSDK } from './merchant.js';
import { createLocalWithdrawalSigner } from './withdrawalSigner.js';
import { privateKeyToAccount } from 'viem/accounts';
import { concatHex, keccak256, pad } from 'viem';

const CHALLENGE_DOMAIN_HASH =
  '0xe32e24a51c351093d339c0035177dc2da5c1b8b9563e414393edd75506dcc055' as const;

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

    const result = await sdk.verifyShieldedPayment(null, null, {
      challengeNonce: issued.requirement.challengeNonce
    });
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

    const signature = await account.signMessage({ message: JSON.stringify(payload) });
    const result = await sdk.verifyShieldedPayment(JSON.stringify(payload), signature, {
      challengeNonce: issued.requirement.challengeNonce
    });

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
    const amountWord = (`0x${(10n).toString(16).padStart(64, '0')}` as `0x${string}`);
    const challengeHash = keccak256(
      concatHex([
        CHALLENGE_DOMAIN_HASH,
        issued.requirement.challengeNonce as `0x${string}`,
        amountWord,
        pad('0x0000000000000000000000000000000000000002', { size: 32 })
      ])
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
    const first = await sdk.verifyShieldedPayment(raw, signature, {
      challengeNonce: issued.requirement.challengeNonce
    });
    expect(first.ok).toBe(true);

    seen.add(payload.nullifier);
    const second = await sdk.verifyShieldedPayment(raw, signature, {
      challengeNonce: issued.requirement.challengeNonce
    });
    expect(second.ok).toBe(false);
  });

  it('creates signed withdraw auth payload', async () => {
    const signer = createLocalWithdrawalSigner(
      '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0'
    );

    const sdk = new ShieldedMerchantSDK(
      {
        rail: 'shielded-usdc',
        price: 10n,
        merchantSignerAddress: signer.address,
        merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        verifyingContract: '0x0000000000000000000000000000000000000002',
        challengeTtlMs: 10000,
        now: () => 1_000_000
      },
      {
        verifyProof: async () => true,
        isNullifierUsed: async () => false,
        signWithdrawalDigest: signer.signDigest
      }
    );

    const result = await sdk.decryptAndWithdraw({
      encryptedNote: '0x1234',
      recipient: '0x0000000000000000000000000000000000000009',
      amount: 3n
    });

    expect(result.signature.startsWith('0x')).toBe(true);
    expect(result.amount).toBe(3n);
    expect(result.encodedAuth.startsWith('0x')).toBe(true);
  });
});
