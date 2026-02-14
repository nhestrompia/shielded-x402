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
  rail: 'shielded-usdc';
  amount: string;
  challengeNonce: string;
  challengeExpiry: string;
  merchantPubKey: Hex;
  verifyingContract: Hex;
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
