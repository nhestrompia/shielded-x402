import {
  type CreditChannelStatus,
  canonicalMerchantRequestHash,
  hashCreditState,
  hashCreditDebitIntent,
  isHex,
  isHex32,
  normalizeRequirement,
  validateShieldedPaymentResponseShape,
  type RelayerCreditCloseChallengeRequest,
  type RelayerCreditCloseChallengeResponse,
  type RelayerCreditCloseFinalizeRequest,
  type RelayerCreditCloseFinalizeResponse,
  type RelayerCreditCloseStartRequest,
  type RelayerCreditCloseStartResponse,
  type CreditDomainResponse,
  type CreditState,
  type SignedCreditState,
  type RelayerCreditPayRequest,
  type RelayerCreditPayResponse,
  type RelayerCreditTopupRequest,
  type RelayerCreditTopupResponse
} from '@shielded-x402/shared-types';
import type { CreditRelayerProcessor, CreditRelayerProcessorConfig } from './types.js';
import {
  recoverCreditDebitSigner,
  recoverCreditStateSigner,
  recoverPayloadSigner,
  signCreditState
} from './creditSignatures.js';

function parseUint(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function nowSeconds(now: () => number): bigint {
  return BigInt(Math.floor(now() / 1000));
}

async function verifySignedState(domain: CreditDomainResponse, stateEnvelope: SignedCreditState) {
  const state = stateEnvelope.state;
  if (!isHex32(state.channelId)) throw new Error('invalid channelId');
  if (!isHex32(state.lastDebitDigest)) throw new Error('invalid lastDebitDigest');
  const stateAgent = await recoverCreditStateSigner(domain, state, stateEnvelope.agentSignature);
  const stateRelayer = await recoverCreditStateSigner(domain, state, stateEnvelope.relayerSignature);
  if (stateAgent !== state.agentAddress.toLowerCase()) {
    throw new Error('latestState agent signature mismatch');
  }
  if (stateRelayer !== state.relayerAddress.toLowerCase()) {
    throw new Error('latestState relayer signature mismatch');
  }
  if (state.relayerAddress.toLowerCase() !== domain.relayerAddress.toLowerCase()) {
    throw new Error('latestState relayer address mismatch');
  }
}

function buildSettlementId(prefix: string, requestId: string): string {
  const normalized = requestId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = normalized.length > 0 ? normalized.slice(0, 24) : 'request';
  return `${prefix}_${suffix}`;
}

function toFailedResponse<
  T extends {
    status: 'DONE' | 'FAILED';
    channelId: string;
    failureReason?: string;
  }
>(base: Omit<T, 'status' | 'failureReason'>, reason: string): T {
  return {
    ...base,
    status: 'FAILED',
    failureReason: reason
  } as T;
}

async function wrapWithFailure<
  T extends {
    status: 'DONE' | 'FAILED';
    channelId: string;
    failureReason?: string;
  }
>(base: Omit<T, 'status' | 'failureReason'>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return toFailedResponse<T>(base, reason);
  }
}

export function createCreditRelayerProcessor(config: CreditRelayerProcessorConfig): CreditRelayerProcessor {
  const now = config.now ?? Date.now;
  const topupCache = new Map<string, RelayerCreditTopupResponse>();
  const payCache = new Map<string, RelayerCreditPayResponse>();
  const channelHeads = new Map<string, CreditState>();
  const channelBusy = new Set<string>();
  const channelWaiters = new Map<string, Array<() => void>>();

  const domain = (): CreditDomainResponse => config.creditDomain;
  const normalizedChannelId = (channelId: string): string => channelId.toLowerCase();

  const withChannelLock = async <T>(channelId: string, fn: () => Promise<T>): Promise<T> => {
    const normalized = normalizedChannelId(channelId);
    if (channelBusy.has(normalized)) {
      await new Promise<void>((resolve) => {
        const waiters = channelWaiters.get(normalized) ?? [];
        waiters.push(resolve);
        channelWaiters.set(normalized, waiters);
      });
    } else {
      channelBusy.add(normalized);
    }

    try {
      return await fn();
    } finally {
      const waiters = channelWaiters.get(normalized);
      if (waiters && waiters.length > 0) {
        const next = waiters.shift();
        if (waiters.length === 0) {
          channelWaiters.delete(normalized);
        }
        next?.();
      } else {
        channelBusy.delete(normalized);
      }
    }
  };

  const withIdempotentChannelLock = async <T>(
    requestId: string,
    channelId: string,
    cache: Map<string, T>,
    fn: () => Promise<T>
  ): Promise<T> => {
    const cached = cache.get(requestId);
    if (cached) return cached;

    return withChannelLock(channelId, async () => {
      const cachedInside = cache.get(requestId);
      if (cachedInside) return cachedInside;
      const result = await fn();
      cache.set(requestId, result);
      return result;
    });
  };

  const getHead = async (channelId: string): Promise<CreditState | undefined> => {
    const normalized = normalizedChannelId(channelId);
    const local = channelHeads.get(normalized);
    if (local) return local;
    if (!config.headStore) return undefined;
    const persisted = await config.headStore.get(normalized as `0x${string}`);
    if (persisted) {
      channelHeads.set(normalized, persisted);
    }
    return persisted;
  };

  const assertMatchesHead = async (channelId: string, provided: CreditState): Promise<void> => {
    const head = await getHead(channelId);
    if (!head) return;
    const expectedHash = hashCreditState(head);
    const providedHash = hashCreditState(provided);
    if (expectedHash.toLowerCase() !== providedHash.toLowerCase()) {
      throw new Error('stale latestState: does not match relayer channel head');
    }
  };

  const setHead = async (channelId: string, state: CreditState): Promise<void> => {
    const normalized = normalizedChannelId(channelId);
    channelHeads.set(normalized, state);
    if (config.headStore) {
      await config.headStore.put(state);
    }
  };

  const clearHead = async (channelId: string): Promise<void> => {
    const normalized = normalizedChannelId(channelId);
    channelHeads.delete(normalized);
    if (config.headStore) {
      await config.headStore.delete(normalized as `0x${string}`);
    }
  };

  const validatePayRequestShape = (request: RelayerCreditPayRequest): void => {
    if (request.requestId !== request.debitIntent.requestId) {
      throw new Error('requestId mismatch between request and debitIntent');
    }
    if (!isHex(request.debitIntentSignature)) {
      throw new Error('invalid debit intent signature encoding');
    }
  };

  const validatePayStateAndIntent = async (
    request: RelayerCreditPayRequest
  ): Promise<{
    current: CreditState;
    normalizedRequirement: ReturnType<typeof normalizeRequirement>;
    amount: bigint;
    available: bigint;
    nextSeq: bigint;
  }> => {
    const normalizedRequirement = normalizeRequirement(request.requirement);
    await verifySignedState(domain(), request.latestState);

    const current = request.latestState.state;
    await assertMatchesHead(current.channelId, current);
    if (current.channelId.toLowerCase() !== request.debitIntent.channelId.toLowerCase()) {
      throw new Error('debitIntent channelId mismatch');
    }

    const expectedHash = canonicalMerchantRequestHash({
      merchantRequest: request.merchantRequest,
      requirement: normalizedRequirement
    });
    if (request.debitIntent.merchantRequestHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error('merchantRequestHash mismatch');
    }

    const currentStateHash = hashCreditState(current);
    if (request.debitIntent.prevStateHash.toLowerCase() !== currentStateHash.toLowerCase()) {
      throw new Error('prevStateHash mismatch');
    }

    const signer = await recoverCreditDebitSigner(
      domain(),
      request.debitIntent,
      request.debitIntentSignature
    );
    if (signer !== current.agentAddress.toLowerCase()) {
      throw new Error('debit intent signer mismatch');
    }

    const nextSeq = parseUint(request.debitIntent.nextSeq, 'debitIntent.nextSeq');
    const currentSeq = parseUint(current.seq, 'latestState.seq');
    if (nextSeq !== currentSeq + 1n) {
      throw new Error('debitIntent.nextSeq must be latestState.seq + 1');
    }

    const amount = parseUint(request.debitIntent.amount, 'debitIntent.amount');
    const available = parseUint(current.available, 'latestState.available');
    if (amount > available) {
      throw new Error('insufficient channel credit');
    }
    if (amount.toString() !== parseUint(normalizedRequirement.amount, 'requirement.amount').toString()) {
      throw new Error('debit amount must equal requirement amount');
    }

    const deadline = parseUint(request.debitIntent.deadline, 'debitIntent.deadline');
    if (nowSeconds(now) > deadline) {
      throw new Error('debit intent expired');
    }

    return {
      current,
      normalizedRequirement,
      amount,
      available,
      nextSeq
    };
  };

  const payMerchantForDebit = async (
    request: RelayerCreditPayRequest,
    normalizedRequirement: ReturnType<typeof normalizeRequirement>
  ) => {
    const settlementId = buildSettlementId('credit', request.requestId);
    const merchantHeaders = {
      ...(request.merchantRequest.headers ?? {}),
      'x-relayer-request-id': request.requestId,
      'x-idempotency-key': request.requestId
    };
    const merchantResult = await config.payout.payMerchant({
      settlementId,
      merchantRequest: {
        ...request.merchantRequest,
        headers: merchantHeaders
      },
      requirement: normalizedRequirement,
      nullifier: hashCreditDebitIntent(request.debitIntent)
    });

    if (merchantResult.status >= 400) {
      throw new Error(`merchant payout failed with status ${merchantResult.status}`);
    }
    return merchantResult;
  };

  const buildNextPayState = (params: {
    current: CreditState;
    nextSeq: bigint;
    amount: bigint;
    available: bigint;
    debitDigest: `0x${string}`;
  }): CreditState => {
    const cumulativeSpent = parseUint(params.current.cumulativeSpent, 'latestState.cumulativeSpent');
    return {
      channelId: params.current.channelId,
      seq: params.nextSeq.toString(),
      available: (params.available - params.amount).toString(),
      cumulativeSpent: (cumulativeSpent + params.amount).toString(),
      lastDebitDigest: params.debitDigest,
      updatedAt: nowSeconds(now).toString(),
      agentAddress: params.current.agentAddress,
      relayerAddress: params.current.relayerAddress
    };
  };

  const validateTopupRequestShape = (request: RelayerCreditTopupRequest): bigint => {
    if (!isHex32(request.channelId)) {
      throw new Error('invalid channelId');
    }
    const payloadValidationError = validateShieldedPaymentResponseShape(request.paymentPayload, {
      exactPublicInputsLength: 6
    });
    if (payloadValidationError) {
      throw new Error(payloadValidationError);
    }
    if (!isHex(request.paymentPayloadSignature)) {
      throw new Error('invalid payment payload signature');
    }
    const amountHex = request.paymentPayload.publicInputs[5];
    if (!amountHex) throw new Error('missing amount input');
    const amount = BigInt(amountHex);
    if (amount <= 0n) throw new Error('topup amount must be greater than zero');
    return amount;
  };

  const validateTopupLatestState = async (
    request: RelayerCreditTopupRequest,
    payerAddress: `0x${string}`
  ): Promise<void> => {
    if (request.latestState) {
      await verifySignedState(domain(), request.latestState);
      if (request.latestState.state.channelId.toLowerCase() !== request.channelId.toLowerCase()) {
        throw new Error('latestState channelId mismatch');
      }
      if (request.latestState.state.agentAddress.toLowerCase() !== payerAddress.toLowerCase()) {
        throw new Error('latestState agent mismatch');
      }
      await assertMatchesHead(request.channelId, request.latestState.state);
      return;
    }

    if (await getHead(request.channelId)) {
      throw new Error('latestState is required when relayer already has channel head');
    }
  };

  const verifyAndSettleTopup = async (
    request: RelayerCreditTopupRequest
  ): Promise<{
    payerAddress: `0x${string}`;
  }> => {
    const payloadJson = JSON.stringify(request.paymentPayload);
    const payerAddress = await recoverPayloadSigner(payloadJson, request.paymentPayloadSignature);

    const nullifierUsed = await config.verifier.isNullifierUsed(request.paymentPayload.nullifier);
    if (nullifierUsed) throw new Error('nullifier already used');

    const proofOk = await config.verifier.verifyProof(request.paymentPayload);
    if (!proofOk) throw new Error('proof verification failed');

    return { payerAddress };
  };

  const settleTopupOnchain = async (
    request: RelayerCreditTopupRequest
  ): Promise<Awaited<ReturnType<typeof config.settlement.settleOnchain>>> => {
    const settlement = await config.settlement.settleOnchain(request.paymentPayload);
    if (settlement.alreadySettled) {
      throw new Error('already settled onchain');
    }
    return settlement;
  };

  const buildNextTopupState = (params: {
    request: RelayerCreditTopupRequest;
    payerAddress: `0x${string}`;
    amount: bigint;
  }): CreditState => {
    const previous = params.request.latestState?.state;
    return {
      channelId: params.request.channelId,
      seq: previous ? (parseUint(previous.seq, 'latestState.seq') + 1n).toString() : '0',
      available: (
        (previous ? parseUint(previous.available, 'latestState.available') : 0n) + params.amount
      ).toString(),
      cumulativeSpent: previous
        ? parseUint(previous.cumulativeSpent, 'latestState.cumulativeSpent').toString()
        : '0',
      lastDebitDigest: params.request.paymentPayload.nullifier,
      updatedAt: nowSeconds(now).toString(),
      agentAddress: params.payerAddress,
      relayerAddress: domain().relayerAddress
    };
  };

  const maybeOpenCreditSettlementTopup = async (
    channelId: `0x${string}`,
    payerAddress: `0x${string}`,
    amount: bigint
  ): Promise<void> => {
    if (!config.creditSettlement) return;
    await config.creditSettlement.openOrTopup({
      channelId,
      agentAddress: payerAddress,
      amount
    });
  };

  return {
    domain,
    handleTopup: async (request) => {
      return withIdempotentChannelLock(request.requestId, request.channelId, topupCache, async () => {
        return wrapWithFailure<RelayerCreditTopupResponse>(
          {
            requestId: request.requestId,
            channelId: request.channelId
          },
          async () => {
          const amount = validateTopupRequestShape(request);
          const { payerAddress } = await verifyAndSettleTopup(request);
          await validateTopupLatestState(request, payerAddress);
          const settlement = await settleTopupOnchain(request);
          const nextState = buildNextTopupState({
            request,
            payerAddress,
            amount
          });
          const signature = await signCreditState(domain(), nextState, config.relayerPrivateKey);

          const response: RelayerCreditTopupResponse = {
            requestId: request.requestId,
            status: 'DONE',
            channelId: request.channelId,
            nextState,
            nextStateRelayerSignature: signature,
            ...(settlement.txHash ? { settlementTxHash: settlement.txHash } : {}),
            amountCredited: amount.toString(),
            settledNullifier: request.paymentPayload.nullifier
          };

          await maybeOpenCreditSettlementTopup(request.channelId, payerAddress, amount);

          await setHead(request.channelId, nextState);
          return response;
          }
        );
      });
    },
    handlePay: async (request) => {
      return withIdempotentChannelLock(
        request.requestId,
        request.latestState.state.channelId,
        payCache,
        async () => {
          return wrapWithFailure<RelayerCreditPayResponse>(
            {
              requestId: request.requestId,
              channelId: request.latestState.state.channelId
            },
            async () => {
            validatePayRequestShape(request);
            const { current, normalizedRequirement, amount, available, nextSeq } =
              await validatePayStateAndIntent(request);
            const merchantResult = await payMerchantForDebit(request, normalizedRequirement);
            const nextState = buildNextPayState({
              current,
              nextSeq,
              amount,
              available,
              debitDigest: hashCreditDebitIntent(request.debitIntent)
            });
            const relayerSignature = await signCreditState(
              domain(),
              nextState,
              config.relayerPrivateKey
            );

            const response: RelayerCreditPayResponse = {
              requestId: request.requestId,
              status: 'DONE',
              channelId: current.channelId,
              nextState,
              nextStateRelayerSignature: relayerSignature,
              merchantResult
            };
            await setHead(current.channelId, nextState);
            return response;
            }
          );
        }
      );
    },
    handleCloseStart: async (request) => {
      return withChannelLock(request.latestState.state.channelId, async () => {
        return wrapWithFailure<RelayerCreditCloseStartResponse>(
          {
            channelId: request.latestState.state.channelId
          },
          async () => {
          if (!config.creditSettlement) {
            throw new Error('credit settlement is not configured');
          }
          await verifySignedState(domain(), request.latestState);
          await assertMatchesHead(request.latestState.state.channelId, request.latestState.state);
          const result = await config.creditSettlement.startClose({
            signedState: request.latestState
          });
          return {
            status: 'DONE',
            channelId: request.latestState.state.channelId,
            txHash: result.txHash,
            challengeDeadline: result.challengeDeadline.toString()
          };
          }
        );
      });
    },
    handleCloseChallenge: async (request) => {
      return withChannelLock(request.higherState.state.channelId, async () => {
        return wrapWithFailure<RelayerCreditCloseChallengeResponse>(
          {
            channelId: request.higherState.state.channelId
          },
          async () => {
          if (!config.creditSettlement) {
            throw new Error('credit settlement is not configured');
          }
          await verifySignedState(domain(), request.higherState);

          const head = await getHead(request.higherState.state.channelId);
          if (head && parseUint(request.higherState.state.seq, 'higherState.seq') < parseUint(head.seq, 'head.seq')) {
            throw new Error('higherState is behind current relayer channel head');
          }

          const result = await config.creditSettlement.challengeClose({
            signedState: request.higherState
          });
          await setHead(request.higherState.state.channelId, request.higherState.state);
          return {
            status: 'DONE',
            channelId: request.higherState.state.channelId,
            txHash: result.txHash,
            challengeDeadline: result.challengeDeadline.toString()
          };
          }
        );
      });
    },
    handleCloseFinalize: async (request) => {
      return withChannelLock(request.channelId, async () => {
        return wrapWithFailure<RelayerCreditCloseFinalizeResponse>(
          {
            channelId: request.channelId
          },
          async () => {
          if (!config.creditSettlement) {
            throw new Error('credit settlement is not configured');
          }
          const result = await config.creditSettlement.finalizeClose({
            channelId: request.channelId
          });
          await clearHead(request.channelId);
          return {
            status: 'DONE',
            channelId: request.channelId,
            txHash: result.txHash,
            paidToAgent: result.paidToAgent.toString(),
            paidToRelayer: result.paidToRelayer.toString()
          };
          }
        );
      });
    },
    getCloseStatus: async (channelId): Promise<CreditChannelStatus> => {
      if (!config.creditSettlement) {
        return {
          channelId,
          exists: false,
          closing: false
        };
      }
      return config.creditSettlement.getChannel({ channelId });
    }
  };
}
