import type { Hex, PaymentRequirement, ShieldedPaymentResponse } from '@shielded-x402/shared-types';

export interface MerchantConfig {
  rail: 'shielded-usdc';
  price: bigint;
  network?: string;
  asset?: Hex;
  payTo?: Hex;
  merchantPubKey: Hex;
  verifyingContract: Hex;
  challengeTtlMs: number;
  fixedChallengeNonce?: Hex;
  now?: () => number;
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
}

export interface SettlementRecord {
  nullifier: Hex;
  root: Hex;
  txHash?: Hex;
  acceptedAt: number;
}

export interface WithdrawRequest {
  nullifier: Hex;
  challengeNonce: Hex;
  recipient: Hex;
}

export interface WithdrawResult {
  nullifier: Hex;
  challengeNonce: Hex;
  recipient: Hex;
  encodedCallData: Hex;
}

export interface ChallengeIssue {
  requirement: PaymentRequirement;
  headerValue: string;
}
