import { X402_HEADERS, type Hex, type PaymentRequirement, type ShieldedNote, type ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { randomBytes } from 'node:crypto';
import { deriveChallengeHash, deriveCommitment, deriveNullifier } from './crypto.js';
import { deriveWitness, type MerkleWitness } from './merkle.js';
import type { Parsed402, ShieldedClientConfig, SpendBuildParams, SpendProofBundle } from './types.js';

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomFieldHex(): Hex {
  while (true) {
    const candidate = BigInt(`0x${randomBytes(32).toString('hex')}`);
    if (candidate < BN254_FIELD_MODULUS) {
      return (`0x${candidate.toString(16).padStart(64, '0')}`) as Hex;
    }
  }
}

export class ShieldedClientSDK {
  constructor(private readonly config: ShieldedClientConfig) {}

  async deposit(amount: bigint, ownerPkHash: Hex): Promise<{ note: ShieldedNote; txHash?: Hex; leafIndex: number }> {
    const rho = randomFieldHex();
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
    const merchantRho = params.merchantRho ?? randomFieldHex();
    const merchantCommitment = deriveCommitment(params.amount, merchantRho, params.merchantPubKey);
    const changeAmount = params.note.amount - params.amount;
    const changeRho = params.changeRho ?? randomFieldHex();
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

  async buildSpendProofWithProvider(params: SpendBuildParams): Promise<SpendProofBundle> {
    const bundle = this.buildSpendProof(params);
    return this.attachRealProof(bundle, params);
  }

  private async attachRealProof(bundle: SpendProofBundle, params: SpendBuildParams): Promise<SpendProofBundle> {
    if (!this.config.proofProvider) {
      return bundle;
    }

    const proofResult = await this.config.proofProvider.generateProof({
      note: params.note,
      witness: params.witness,
      nullifierSecret: params.nullifierSecret,
      merchantPubKey: params.merchantPubKey,
      merchantRho: bundle.merchantRho,
      changePkHash: params.note.pkHash,
      changeRho: bundle.changeNote.rho,
      amount: params.amount,
      challengeNonce: params.challengeNonce,
      merchantAddress: params.merchantAddress,
      expectedPublicInputs: bundle.response.publicInputs
    });

    const publicInputs = proofResult.publicInputs ?? bundle.response.publicInputs;
    return {
      ...bundle,
      response: {
        ...bundle.response,
        proof: proofResult.proof,
        publicInputs
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

  async complete402Payment(
    input: string,
    init: RequestInit,
    requirement: PaymentRequirement,
    note: ShieldedNote,
    witness: MerkleWitness,
    payerPkHash: Hex,
    fetchFn: typeof fetch = fetch
  ): Promise<Response> {
    if (requirement.rail !== 'shielded-usdc') {
      throw new Error(`unsupported rail: ${requirement.rail}`);
    }

    const nonce = requirement.challengeNonce as Hex;
    const merchant = requirement.verifyingContract;
    const amount = BigInt(requirement.amount);

    const spendParams: SpendBuildParams = {
      note,
      witness,
      nullifierSecret: payerPkHash,
      merchantPubKey: requirement.merchantPubKey,
      merchantAddress: merchant,
      amount,
      challengeNonce: nonce,
      encryptedReceipt: '0x'
    };

    const bundleWithProof = await this.buildSpendProofWithProvider(spendParams);

    const signed = await this.pay402(bundleWithProof.response);
    const headers = new Headers(init.headers);
    headers.set(X402_HEADERS.paymentResponse, signed.payload);
    headers.set(X402_HEADERS.paymentSignature, signed.signature);
    headers.set(X402_HEADERS.challengeNonce, requirement.challengeNonce);

    return fetchFn(input, {
      ...init,
      headers
    });
  }

  async fetchWithShieldedPayment(input: string, init: RequestInit, note: ShieldedNote, witness: MerkleWitness, payerPkHash: Hex): Promise<Response> {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;

    const parsed = this.parse402Response(first);
    return this.complete402Payment(input, init, parsed.requirement, note, witness, payerPkHash);
  }
}

export function buildWitnessFromCommitments(commitments: Hex[], targetIndex: number): MerkleWitness {
  return deriveWitness(commitments, targetIndex);
}
