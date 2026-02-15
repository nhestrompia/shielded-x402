import { randomBytes } from 'node:crypto';
import {
  concatHex,
  pad,
  hashMessage,
  recoverAddress,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  parseAbiParameters,
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
  CRYPTO_SPEC,
  buildPaymentRequiredHeader,
  normalizeRequirement,
  parsePaymentSignatureHeader,
  type PaymentRequirement,
  type ShieldedPaymentResponse
} from '@shielded-x402/shared-types';

const withdrawArgs = parseAbiParameters('address merchant,address recipient,uint256 amount,bytes32 claimId,uint64 deadline,uint8 v,bytes32 r,bytes32 s');

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

function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const compact = signature.slice(2);
  if (compact.length !== 130) {
    throw new Error('invalid signature length');
  }
  const r = (`0x${compact.slice(0, 64)}`) as Hex;
  const s = (`0x${compact.slice(64, 128)}`) as Hex;
  let v = Number.parseInt(compact.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
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
    if (!this.validatePayloadShape(payload)) return { ok: false, reason: 'invalid payment payload schema' };
    if (payload.publicInputs.length !== 6) return { ok: false, reason: 'invalid public input length' };

    const amountWord = (`0x${expiresAt.amount.toString(16).padStart(64, '0')}` as Hex);
    const merchantWord = pad(this.config.verifyingContract, { size: 32 });
    const expectedChallengeHash = keccak256(
      concatHex([
        CRYPTO_SPEC.challengeDomainHash as Hex,
        challengeNonce as Hex,
        amountWord,
        merchantWord
      ])
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
    const merchant = this.config.merchantSignerAddress;
    if (!merchant) {
      throw new Error('merchantSignerAddress is required for withdraw signing');
    }
    if (!this.hooks.signWithdrawalDigest) {
      throw new Error('signWithdrawalDigest hook is required for withdraw signing');
    }

    const amount = request.amount ?? this.config.price;
    const claimId =
      request.claimId ??
      keccak256(
        encodeAbiParameters(
          parseAbiParameters('bytes encryptedNote,address recipient,uint256 amount'),
          [request.encryptedNote, request.recipient, amount]
        )
      );
    const deadline = BigInt(
      request.deadline ??
        Math.floor(this.currentTime() / 1000) + (this.config.withdrawalTtlSec ?? 600)
    );

    const digest = keccak256(
      encodePacked(
        ['string', 'address', 'bytes', 'address', 'uint256', 'bytes32', 'uint64'],
        [
          'shielded-x402:v1:withdraw',
          this.config.verifyingContract,
          request.encryptedNote,
          request.recipient,
          amount,
          claimId,
          deadline
        ]
      )
    );

    const signature = await this.hooks.signWithdrawalDigest(digest);
    const { v, r, s } = splitSignature(signature);

    const encodedAuth = encodeAbiParameters(withdrawArgs, [
      merchant,
      request.recipient,
      amount,
      claimId,
      deadline,
      v,
      r,
      s
    ]);

    return {
      claimId,
      merchant,
      amount,
      deadline,
      signature,
      digest,
      encodedAuth
    };
  }

  private currentTime(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private validatePayloadShape(payload: unknown): payload is ShieldedPaymentResponse {
    if (!payload || typeof payload !== 'object') return false;
    const cast = payload as Record<string, unknown>;

    if (!Array.isArray(cast.publicInputs)) return false;
    if (typeof cast.proof !== 'string') return false;
    if (typeof cast.nullifier !== 'string') return false;
    if (typeof cast.root !== 'string') return false;
    if (typeof cast.merchantCommitment !== 'string') return false;
    if (typeof cast.changeCommitment !== 'string') return false;
    if (typeof cast.challengeHash !== 'string') return false;
    if (typeof cast.encryptedReceipt !== 'string') return false;

    const hexLike = /^0x[0-9a-fA-F]*$/;
    const fixedHex = /^0x[0-9a-fA-F]{64}$/;
    const publicInputsValid = cast.publicInputs.every(
      (value) => typeof value === 'string' && hexLike.test(value)
    );

    return (
      cast.proof.length <= 262144 &&
      cast.publicInputs.length > 0 &&
      publicInputsValid &&
      fixedHex.test(cast.nullifier) &&
      fixedHex.test(cast.root) &&
      fixedHex.test(cast.merchantCommitment) &&
      fixedHex.test(cast.changeCommitment) &&
      fixedHex.test(cast.challengeHash) &&
      hexLike.test(cast.encryptedReceipt)
    );
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
