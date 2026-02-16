import type { Hex, PaymentRequirement, ShieldedNote, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import type { MerkleWitness } from './merkle.js';

export interface ProofProviderRequest {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
  merchantPubKey: Hex;
  merchantRho: Hex;
  changePkHash: Hex;
  changeRho: Hex;
  amount: bigint;
  challengeNonce: Hex;
  merchantAddress: Hex;
  expectedPublicInputs: Hex[];
}

export interface ProofProviderResult {
  proof: Hex;
  publicInputs?: Hex[];
}

export interface ProofProvider {
  generateProof: (request: ProofProviderRequest) => Promise<ProofProviderResult>;
}

export interface SpendBuildParams {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
  changeNullifierSecret?: Hex;
  merchantPubKey: Hex;
  merchantRho?: Hex;
  merchantAddress: Hex;
  changeRho?: Hex;
  amount: bigint;
  challengeNonce: Hex;
  encryptedReceipt: Hex;
}

export interface SpendProofBundle {
  response: ShieldedPaymentResponse;
  changeNote: ShieldedNote;
  changeNullifierSecret: Hex;
  merchantRho: Hex;
}

export interface ShieldedClientConfig {
  endpoint: string;
  signer: (message: string) => Promise<string>;
  depositFn?: (amount: bigint, commitment: Hex) => Promise<{ txHash: Hex; leafIndex: number }>;
  proofProvider?: ProofProvider;
}

export interface Parsed402 {
  requirement: PaymentRequirement;
}

export interface Prepared402Payment {
  requirement: PaymentRequirement;
  headers: Headers;
  response: ShieldedPaymentResponse;
  changeNote: ShieldedNote;
  changeNullifierSecret: Hex;
}
