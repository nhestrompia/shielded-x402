import type { Hex, PaymentRequirement, ShieldedPaymentResponse } from '@shielded-x402/shared-types';

export interface MerchantConfig {
  rail: 'shielded-usdc';
  price: bigint;
  merchantSignerAddress?: Hex;
  merchantPubKey: Hex;
  verifyingContract: Hex;
  challengeTtlMs: number;
  fixedChallengeNonce?: Hex;
  withdrawalTtlSec?: number;
  now?: () => number;
}

export interface VerifyContext {
  challengeNonce: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  payerAddress?: Hex;
  payload?: ShieldedPaymentResponse;
}

export interface MerchantHooks {
  verifyProof: (payload: ShieldedPaymentResponse) => Promise<boolean>;
  isNullifierUsed: (nullifier: Hex) => Promise<boolean>;
  signWithdrawalDigest?: (digest: Hex) => Promise<Hex>;
}

export interface SettlementRecord {
  nullifier: Hex;
  root: Hex;
  txHash?: Hex;
  acceptedAt: number;
}

export interface WithdrawRequest {
  encryptedNote: Hex;
  recipient: Hex;
  amount?: bigint;
  claimId?: Hex;
  deadline?: number;
}

export interface WithdrawResult {
  claimId: Hex;
  merchant: Hex;
  amount: bigint;
  deadline: bigint;
  signature: Hex;
  digest: Hex;
  encodedAuth: Hex;
}

export interface ChallengeIssue {
  requirement: PaymentRequirement;
  headerValue: string;
}
