import { randomBytes } from 'node:crypto';
import {
  concatHex,
  hashMessage,
  recoverAddress,
  keccak256,
  encodeFunctionData,
  type Hex
} from 'viem';
import type {
  ChallengeIssue,
  MerchantConfig,
  MerchantHooks,
  SettlementRecord,
  VerifyResult,
  WithdrawRequest,
  WithdrawResult
} from './types.js';
import {
  challengeHashPreimage,
  buildPaymentRequiredHeader,
  normalizeRequirement,
  parsePaymentSignatureHeader,
  validateShieldedPaymentResponseShape,
  type PaymentRequirement,
  type ShieldedPaymentResponse
} from '@shielded-x402/shared-types';

const withdrawAbi = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'nullifier', type: 'bytes32' },
      { name: 'challengeNonce', type: 'bytes32' },
      { name: 'recipient', type: 'address' }
    ],
    outputs: []
  }
] as const;

interface ActiveChallenge {
  expiresAt: number;
  amount: bigint;
}

interface SignedPaymentEnvelope {
  payload: ShieldedPaymentResponse;
  signature: Hex;
  challengeNonce: string;
  accepted?: PaymentRequirement;
}

function randomHex32(): Hex {
  return (`0x${randomBytes(32).toString('hex')}`) as Hex;
}

export class ShieldedMerchantSDK {
  private readonly activeChallenges = new Map<string, ActiveChallenge>();
  private readonly accepted = new Map<string, SettlementRecord>();

  constructor(
    private readonly config: MerchantConfig,
    private readonly hooks: MerchantHooks
  ) {}

  issue402(): ChallengeIssue {
    const now = this.currentTime();
    const nonce = this.config.fixedChallengeNonce ?? randomHex32();
    const expiry = now + this.config.challengeTtlMs;
    this.activeChallenges.set(nonce, {
      expiresAt: expiry,
      amount: this.config.price
    });

    const requirement = normalizeRequirement({
      x402Version: 2,
      scheme: 'exact',
      network: this.config.network ?? 'eip155:11155111',
      asset:
        this.config.asset ??
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      payTo: this.config.payTo ?? this.config.verifyingContract,
      rail: this.config.rail,
      amount: this.config.price.toString(),
      challengeNonce: nonce,
      challengeExpiry: String(expiry),
      merchantPubKey: this.config.merchantPubKey,
      verifyingContract: this.config.verifyingContract,
      maxTimeoutSeconds: Math.floor(this.config.challengeTtlMs / 1000),
      extra: {
        rail: this.config.rail,
        challengeNonce: nonce,
        challengeExpiry: String(expiry),
        merchantPubKey: this.config.merchantPubKey,
        verifyingContract: this.config.verifyingContract
      }
    });

    return {
      requirement,
      headerValue: buildPaymentRequiredHeader(requirement)
    };
  }

  async verifyShieldedPayment(signatureHeader: string | null): Promise<VerifyResult> {
    if (!signatureHeader) {
      return { ok: false, reason: 'missing payment headers' };
    }

    let signed: SignedPaymentEnvelope;
    try {
      signed = this.parseSignedPaymentEnvelope(signatureHeader);
    } catch {
      return { ok: false, reason: 'invalid PAYMENT-SIGNATURE header' };
    }
    const payload = signed.payload;
    const signature = signed.signature;
    const challengeNonce = signed.challengeNonce;
    const accepted = signed.accepted;
    if (!accepted) {
      return { ok: false, reason: 'missing accepted requirement in PAYMENT-SIGNATURE' };
    }
    if (!this.requirementMatchesMerchant(accepted)) {
      return { ok: false, reason: 'accepted requirement does not match merchant config' };
    }

    const expiresAt = this.activeChallenges.get(challengeNonce);
    if (!expiresAt) return { ok: false, reason: 'unknown challenge nonce' };
    if (this.currentTime() > expiresAt.expiresAt) return { ok: false, reason: 'challenge expired' };
    const payloadValidationError = validateShieldedPaymentResponseShape(payload, {
      exactPublicInputsLength: 6,
      maxProofHexLength: 262144
    });
    if (payloadValidationError) {
      return { ok: false, reason: payloadValidationError };
    }

    const expectedChallengeHash = keccak256(
      concatHex(
        challengeHashPreimage(challengeNonce as Hex, expiresAt.amount, this.config.verifyingContract)
      )
    );
    if (payload.challengeHash !== expectedChallengeHash) {
      return { ok: false, reason: 'challenge hash mismatch' };
    }

    const amountInput = payload.publicInputs[5];
    let amountValue: bigint;
    try {
      if (!amountInput) throw new Error('missing amount input');
      amountValue = BigInt(amountInput);
    } catch {
      return { ok: false, reason: 'invalid amount encoding' };
    }
    if (amountValue !== expiresAt.amount) {
      return { ok: false, reason: 'amount mismatch' };
    }

    const inUse = await this.hooks.isNullifierUsed(payload.nullifier);
    if (inUse) return { ok: false, reason: 'nullifier already used' };

    const proofOk = await this.hooks.verifyProof(payload);
    if (!proofOk) return { ok: false, reason: 'proof verification failed' };

    let payer: Hex;
    try {
      const signedPayload = JSON.stringify(payload);
      const msgHash = hashMessage(signedPayload);
      payer = (await recoverAddress({ hash: msgHash, signature })) as Hex;
    } catch {
      return { ok: false, reason: 'invalid payment signature' };
    }

    this.activeChallenges.delete(challengeNonce);
    this.accepted.set(payload.nullifier, {
      nullifier: payload.nullifier,
      root: payload.root,
      acceptedAt: this.currentTime()
    });

    return { ok: true, payload, payerAddress: payer };
  }

  async confirmSettlement(nullifier: Hex, txHash?: Hex): Promise<boolean> {
    const entry = this.accepted.get(nullifier);
    if (!entry) return false;
    if (txHash) {
      entry.txHash = txHash;
    }
    this.accepted.set(nullifier, entry);
    return true;
  }

  async decryptAndWithdraw(request: WithdrawRequest): Promise<WithdrawResult> {
    const encodedCallData = encodeFunctionData({
      abi: withdrawAbi,
      functionName: 'withdraw',
      args: [request.nullifier, request.challengeNonce, request.recipient]
    });

    return {
      nullifier: request.nullifier,
      challengeNonce: request.challengeNonce,
      recipient: request.recipient,
      encodedCallData
    };
  }

  private currentTime(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private parseSignedPaymentEnvelope(signatureHeader: string): SignedPaymentEnvelope {
    const envelope = parsePaymentSignatureHeader(signatureHeader);
    const accepted = normalizeRequirement(envelope.accepted);
    const challengeNonce = envelope.challengeNonce ?? accepted.challengeNonce;
    return {
      payload: envelope.payload,
      signature: envelope.signature,
      challengeNonce,
      accepted
    };
  }

  private requirementMatchesMerchant(requirement: PaymentRequirement): boolean {
    return (
      requirement.rail === this.config.rail &&
      requirement.amount === this.config.price.toString() &&
      requirement.merchantPubKey.toLowerCase() === this.config.merchantPubKey.toLowerCase() &&
      requirement.verifyingContract.toLowerCase() === this.config.verifyingContract.toLowerCase()
    );
  }
}
