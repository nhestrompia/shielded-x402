export type Hex = `0x${string}`;

export interface ShieldedNote {
  amount: bigint;
  rho: Hex;
  pkHash: Hex;
  commitment: Hex;
  leafIndex: number;
}

export interface SpendPublicInputs {
  nullifier: Hex;
  root: Hex;
  merchantCommitment: Hex;
  changeCommitment: Hex;
  challengeHash: Hex;
  amount: bigint;
}

export interface ShieldedPaymentResponse {
  proof: Hex;
  publicInputs: Hex[];
  nullifier: Hex;
  root: Hex;
  merchantCommitment: Hex;
  changeCommitment: Hex;
  challengeHash: Hex;
  encryptedReceipt: Hex;
  txHint?: string;
}

export interface PaymentRequirement {
  x402Version?: 2;
  scheme: 'exact' | string;
  network: string;
  asset: Hex | string;
  payTo: Hex;
  rail: 'shielded-usdc' | string;
  amount: string;
  challengeNonce: string;
  challengeExpiry: string;
  merchantPubKey: Hex;
  verifyingContract: Hex;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  outputSchema?: string;
  extra?: {
    rail: 'shielded-usdc' | string;
    challengeNonce: string;
    challengeExpiry: string;
    merchantPubKey: Hex;
    verifyingContract: Hex;
  };
}

export interface X402PaymentRequired {
  x402Version: 2;
  accepts: PaymentRequirement[];
  error?: string;
}

export interface X402PaymentSignaturePayload {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: ShieldedPaymentResponse;
  challengeNonce: Hex;
  signature: Hex;
}

export interface AgentRecord {
  did: string;
  endpoint: string;
  encryptionPubKey: Hex;
  capabilities: string[];
  supportedRails: string[];
  signature: Hex;
}

export interface ReputationSignal {
  successfulSettlements: number;
  disputes: number;
  uptime: number;
  attestationRefs: string[];
}

export interface RelayerMerchantRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  challengeUrl?: string;
}

export interface RelayerPayRequest {
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
  paymentSignatureHeader: string;
  idempotencyKey?: string;
}

export type RelayerSettlementStatus =
  | 'RECEIVED'
  | 'VERIFIED'
  | 'SENT_ONCHAIN'
  | 'CONFIRMED'
  | 'PAID_MERCHANT'
  | 'DONE'
  | 'FAILED';

export interface RelayerMerchantResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  payoutReference?: string;
}

export interface RelayerPayResponse {
  settlementId: string;
  status: RelayerSettlementStatus;
  nullifier: Hex;
  settlementTxHash?: Hex;
  merchantResult?: RelayerMerchantResult;
  failureReason?: string;
}
