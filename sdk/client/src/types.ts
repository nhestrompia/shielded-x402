import type { Hex, PaymentRequirement, ShieldedNote, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import type { MerkleWitness } from './merkle.js';

export interface SpendBuildParams {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
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
  merchantRho: Hex;
}

export interface ShieldedClientConfig {
  endpoint: string;
  signer: (message: string) => Promise<string>;
  depositFn?: (amount: bigint, commitment: Hex) => Promise<{ txHash: Hex; leafIndex: number }>;
}

export interface Parsed402 {
  requirement: PaymentRequirement;
}
