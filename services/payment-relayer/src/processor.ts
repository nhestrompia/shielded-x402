import { createHash } from 'node:crypto';
import {
  CRYPTO_SPEC,
  normalizeRequirement,
  parsePaymentSignatureHeader,
  type PaymentRequirement,
  type RelayerPayRequest,
  type ShieldedPaymentResponse
} from '@shielded-x402/shared-types';
import {
  concatHex,
  hashMessage,
  keccak256,
  pad,
  recoverAddress,
  type Hex
} from 'viem';
import type {
  PaymentRelayerProcessorConfig,
  RelayerProcessor,
  SettlementRecord
} from './types.js';
import { requirementsMatch } from './challenge.js';

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function parsePayload(raw: string): ShieldedPaymentResponse {
  const payload = JSON.parse(raw) as unknown;
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid payment payload');
  }

  const cast = payload as Record<string, unknown>;
  if (!isHex(cast.proof)) throw new Error('invalid proof encoding');
  if (!Array.isArray(cast.publicInputs) || cast.publicInputs.length !== 6) {
    throw new Error('invalid public input length');
  }
  for (const input of cast.publicInputs) {
    if (!isHex(input)) {
      throw new Error('invalid public input encoding');
    }
  }
  if (!isHex32(cast.nullifier)) throw new Error('invalid nullifier');
  if (!isHex32(cast.root)) throw new Error('invalid root');
  if (!isHex32(cast.merchantCommitment)) throw new Error('invalid merchant commitment');
  if (!isHex32(cast.changeCommitment)) throw new Error('invalid change commitment');
  if (!isHex32(cast.challengeHash)) throw new Error('invalid challenge hash');
  if (!isHex(cast.encryptedReceipt)) throw new Error('invalid encrypted receipt');

  return cast as unknown as ShieldedPaymentResponse;
}

interface ParsedPaymentArtifacts {
  payload: ShieldedPaymentResponse;
  signature: Hex;
  challengeNonce: Hex;
  acceptedRequirement: PaymentRequirement;
  signedPayloadJson: string;
}

function parsePaymentArtifacts(request: RelayerPayRequest): ParsedPaymentArtifacts {
  const signedEnvelope = parsePaymentSignatureHeader(request.paymentSignatureHeader);
  const payload = parsePayload(JSON.stringify(signedEnvelope.payload));
  return {
    payload,
    signature: signedEnvelope.signature as Hex,
    challengeNonce: signedEnvelope.challengeNonce as Hex,
    acceptedRequirement: normalizeRequirement(signedEnvelope.accepted),
    signedPayloadJson: JSON.stringify(payload)
  };
}

function deriveChallengeHash(requirement: PaymentRequirement, challengeNonce: Hex): Hex {
  const amount = BigInt(requirement.amount);
  const amountWord = (`0x${amount.toString(16).padStart(64, '0')}` as Hex);
  const merchantWord = pad(requirement.verifyingContract, { size: 32 });
  return keccak256(
    concatHex([CRYPTO_SPEC.challengeDomainHash as Hex, challengeNonce, amountWord, merchantWord])
  );
}

function computeIdempotencyKey(
  request: RelayerPayRequest,
  payload: ShieldedPaymentResponse,
  challengeNonce: Hex,
  requirement: PaymentRequirement
): string {
  if (request.idempotencyKey) {
    return request.idempotencyKey;
  }

  const hash = createHash('sha256');
  hash.update(request.merchantRequest.url);
  hash.update(request.merchantRequest.method);
  hash.update(challengeNonce);
  hash.update(requirement.amount);
  hash.update(payload.nullifier);
  hash.update(payload.challengeHash);
  return hash.digest('hex');
}

function computeSettlementId(idempotencyKey: string): string {
  return `settle_${idempotencyKey.slice(0, 24)}`;
}

function toFailure(record: SettlementRecord, reason: string, now: number): SettlementRecord {
  return {
    ...record,
    status: 'FAILED',
    failureReason: reason,
    updatedAt: now
  };
}

function update(
  record: SettlementRecord,
  patch: Partial<SettlementRecord>,
  now: number
): SettlementRecord {
  return {
    ...record,
    ...patch,
    updatedAt: now
  };
}

function assertPayloadBindsToRequirement(
  payload: ShieldedPaymentResponse,
  requirement: PaymentRequirement,
  challengeNonce: Hex
): void {
  const expectedChallengeHash = deriveChallengeHash(requirement, challengeNonce);
  const expectedAmount = BigInt(requirement.amount);
  const amountInput = payload.publicInputs[5];
  if (!amountInput) {
    throw new Error('missing amount public input');
  }

  if (BigInt(amountInput) !== expectedAmount) {
    throw new Error('amount mismatch');
  }

  if (payload.nullifier !== payload.publicInputs[0]) {
    throw new Error('nullifier mismatch in public inputs');
  }
  if (payload.root !== payload.publicInputs[1]) {
    throw new Error('root mismatch in public inputs');
  }
  if (payload.merchantCommitment !== payload.publicInputs[2]) {
    throw new Error('merchant commitment mismatch in public inputs');
  }
  if (payload.changeCommitment !== payload.publicInputs[3]) {
    throw new Error('change commitment mismatch in public inputs');
  }
  if (payload.challengeHash !== payload.publicInputs[4]) {
    throw new Error('challenge hash mismatch in public inputs');
  }

  if (payload.challengeHash.toLowerCase() !== expectedChallengeHash.toLowerCase()) {
    throw new Error('challenge binding mismatch');
  }
}

async function verifyPayerSignature(signedPayloadJson: string, paymentSignature: Hex): Promise<Hex> {
  const messageHash = hashMessage(signedPayloadJson);
  const payer = await recoverAddress({ hash: messageHash, signature: paymentSignature });
  return payer as Hex;
}

export function createPaymentRelayerProcessor(config: PaymentRelayerProcessorConfig): RelayerProcessor {
  const now = config.now ?? Date.now;

  return {
    handlePay: async (request: RelayerPayRequest): Promise<SettlementRecord> => {
      const artifacts = parsePaymentArtifacts(request);
      const payload = artifacts.payload;
      const signedRequirement = artifacts.acceptedRequirement;
      const idempotencyKey = computeIdempotencyKey(
        request,
        payload,
        artifacts.challengeNonce,
        signedRequirement
      );
      const existing = await config.store.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        return existing;
      }

      const settlementId = computeSettlementId(idempotencyKey);
      const createdAt = now();
      let record: SettlementRecord = {
        settlementId,
        idempotencyKey,
        status: 'RECEIVED',
        nullifier: payload.nullifier,
        merchantRequest: request.merchantRequest,
        requirement: signedRequirement,
        createdAt,
        updatedAt: createdAt
      };
      await config.store.put(record);

      try {
        const fetchedRequirement = await config.challengeFetcher.fetchRequirement(request.merchantRequest);
        if (!requirementsMatch(request.requirement, signedRequirement)) {
          throw new Error('request requirement mismatch');
        }
        if (!requirementsMatch(signedRequirement, fetchedRequirement)) {
          throw new Error('merchant challenge mismatch');
        }
        if (
          artifacts.challengeNonce.toLowerCase() !==
          (fetchedRequirement.challengeNonce as Hex).toLowerCase()
        ) {
          throw new Error('challenge nonce mismatch');
        }

        const expiry = Number(fetchedRequirement.challengeExpiry);
        if (!Number.isFinite(expiry) || now() > expiry) {
          throw new Error('challenge expired');
        }

        const payerAddress = await verifyPayerSignature(
          artifacts.signedPayloadJson,
          artifacts.signature
        );

        assertPayloadBindsToRequirement(payload, fetchedRequirement, artifacts.challengeNonce);

        const nullifierUsed = await config.verifier.isNullifierUsed(payload.nullifier);
        if (nullifierUsed) {
          throw new Error('nullifier already used');
        }

        const proofOk = await config.verifier.verifyProof(payload);
        if (!proofOk) {
          throw new Error('proof verification failed');
        }

        record = update(record, { status: 'VERIFIED', payerAddress }, now());
        await config.store.put(record);

        record = update(record, { status: 'SENT_ONCHAIN' }, now());
        await config.store.put(record);

        const settlement = await config.settlement.settleOnchain(payload);
        if (settlement.alreadySettled) {
          throw new Error('already settled onchain');
        }

        record = update(
          record,
          {
            status: 'CONFIRMED',
            ...(settlement.txHash ? { settlementTxHash: settlement.txHash } : {})
          },
          now()
        );
        await config.store.put(record);

        const merchantResult = await config.payout.payMerchant({
          settlementId,
          merchantRequest: request.merchantRequest,
          requirement: fetchedRequirement,
          nullifier: payload.nullifier,
          ...(settlement.txHash ? { settlementTxHash: settlement.txHash } : {})
        });

        record = update(record, { status: 'PAID_MERCHANT', merchantResult }, now());
        await config.store.put(record);

        record = update(record, { status: 'DONE' }, now());
        await config.store.put(record);

        return record;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed = toFailure(record, reason, now());
        await config.store.put(failed);
        return failed;
      }
    },

    getStatus: async (settlementId: string): Promise<SettlementRecord | undefined> => {
      return config.store.getBySettlementId(settlementId);
    }
  };
}
