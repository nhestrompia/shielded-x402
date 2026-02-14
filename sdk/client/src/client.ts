import { X402_HEADERS, type Hex, type PaymentRequirement, type ShieldedNote, type ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { randomBytes } from 'node:crypto';
import { deriveChallengeHash, deriveCommitment, deriveNullifier } from './crypto.js';
import { deriveWitness, type MerkleWitness } from './merkle.js';
import type { Parsed402, ShieldedClientConfig, SpendBuildParams, SpendProofBundle } from './types.js';

function randomHex32(): Hex {
  return (`0x${randomBytes(32).toString('hex')}`) as Hex;
}

export class ShieldedClientSDK {
  constructor(private readonly config: ShieldedClientConfig) {}

  async deposit(amount: bigint, ownerPkHash: Hex): Promise<{ note: ShieldedNote; txHash?: Hex; leafIndex: number }> {
    const rho = randomHex32();
    const commitment = deriveCommitment(amount, rho, ownerPkHash);
    const tx = this.config.depositFn ? await this.config.depositFn(amount, commitment) : undefined;

    const result: { note: ShieldedNote; txHash?: Hex; leafIndex: number } = {
      note: {
        amount,
        rho,
        pkHash: ownerPkHash,
        commitment,
        leafIndex: tx?.leafIndex ?? -1
      },
      leafIndex: tx?.leafIndex ?? -1
    };
    if (tx?.txHash) {
      result.txHash = tx.txHash;
    }
    return result;
  }

  buildSpendProof(params: SpendBuildParams): SpendProofBundle {
    if (params.amount > params.note.amount) {
      throw new Error('insufficient note amount');
    }

    const nullifier = deriveNullifier(params.nullifierSecret, params.note.commitment);
    const merchantRho = params.merchantRho ?? randomHex32();
    const merchantCommitment = deriveCommitment(params.amount, merchantRho, params.merchantPubKey);
    const changeAmount = params.note.amount - params.amount;
    const changeRho = params.changeRho ?? randomHex32();
    const changeCommitment = deriveCommitment(changeAmount, changeRho, params.note.pkHash);
    const challengeHash = deriveChallengeHash(params.challengeNonce, params.amount, params.merchantAddress);
    const amountHex = (`0x${params.amount.toString(16).padStart(64, '0')}` as Hex);

    const response: ShieldedPaymentResponse = {
      proof: '0x00',
      publicInputs: [
        nullifier,
        params.witness.root,
        merchantCommitment,
        changeCommitment,
        challengeHash,
        amountHex
      ],
      nullifier,
      root: params.witness.root,
      merchantCommitment,
      changeCommitment,
      challengeHash,
      encryptedReceipt: params.encryptedReceipt,
      txHint: `leaf:${params.note.leafIndex}`
    };

    return {
      merchantRho,
      response,
      changeNote: {
        amount: changeAmount,
        rho: changeRho,
        pkHash: params.note.pkHash,
        commitment: changeCommitment,
        leafIndex: -1
      }
    };
  }

  async pay402(paymentResponse: ShieldedPaymentResponse): Promise<{ payload: string; signature: string }> {
    const payload = JSON.stringify(paymentResponse);
    const signature = await this.config.signer(payload);
    return { payload, signature };
  }

  parse402Response(response: Response): Parsed402 {
    const header = response.headers.get(X402_HEADERS.paymentRequirement);
    if (!header) throw new Error(`missing ${X402_HEADERS.paymentRequirement} header`);
    return { requirement: JSON.parse(header) as PaymentRequirement };
  }

  async fetchWithShieldedPayment(input: string, init: RequestInit, note: ShieldedNote, witness: MerkleWitness, payerPkHash: Hex): Promise<Response> {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;

    const parsed = this.parse402Response(first);
    const nonce = parsed.requirement.challengeNonce as Hex;
    const merchant = parsed.requirement.verifyingContract;
    const amount = BigInt(parsed.requirement.amount);

    const bundle = this.buildSpendProof({
      note,
      witness,
      nullifierSecret: payerPkHash,
      merchantPubKey: parsed.requirement.merchantPubKey,
      merchantAddress: merchant,
      amount,
      challengeNonce: nonce,
      encryptedReceipt: '0x'
    });

    const signed = await this.pay402(bundle.response);
    const headers = new Headers(init.headers);
    headers.set(X402_HEADERS.paymentResponse, signed.payload);
    headers.set(X402_HEADERS.paymentSignature, signed.signature);
    headers.set(X402_HEADERS.challengeNonce, parsed.requirement.challengeNonce);

    return fetch(input, {
      ...init,
      headers
    });
  }
}

export function buildWitnessFromCommitments(commitments: Hex[], targetIndex: number): MerkleWitness {
  return deriveWitness(commitments, targetIndex);
}
