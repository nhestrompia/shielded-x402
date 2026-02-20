import {
  RELAYER_ROUTES,
  canonicalMerchantRequestHash,
  deriveCreditChannelId,
  hashCreditState,
  normalizeRequirement,
  type CreditDomainResponse,
  type CreditChannelId,
  type CreditState,
  type Hex,
  type RelayerCreditPayRequest,
  type RelayerCreditPayResponse,
  type RelayerCreditTopupRequest,
  type RelayerCreditTopupResponse,
  type SignedCreditState
} from '@shielded-x402/shared-types';
import {
  recoverCreditStateSigner,
  signAgentCreditState,
  signDebitIntent,
  type CreditTypedDataSigner
} from './creditSignatures.js';
import { postJson } from './http.js';

export interface CreditStateStore {
  getCreditState: (channelId: Hex) => SignedCreditState | undefined;
  setCreditState: (state: SignedCreditState) => Promise<void> | void;
}

export interface CreditChannelClientConfig {
  relayerEndpoint: string;
  channelId?: Hex;
  agentAddress: Hex;
  signer: CreditTypedDataSigner;
  stateStore?: CreditStateStore;
  fetchImpl?: typeof fetch;
}

export interface CreditPayArgs {
  requestId: string;
  merchantRequest: RelayerCreditPayRequest['merchantRequest'];
  requirement: RelayerCreditPayRequest['requirement'];
  deadlineSeconds?: number;
}

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function normalizeChannelId(channelId: Hex): CreditChannelId {
  const normalized = channelId.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('channelId must be a bytes32 hex string');
  }
  return normalized as CreditChannelId;
}

export function createCreditChannelClient(config: CreditChannelClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = config.relayerEndpoint.replace(/\/$/, '');
  const agentAddress = config.agentAddress.toLowerCase() as Hex;
  let domainCache: CreditDomainResponse | undefined;
  let resolvedChannelId: CreditChannelId | undefined = config.channelId
    ? normalizeChannelId(config.channelId)
    : undefined;
  let payQueue: Promise<void> = Promise.resolve();

  const getDomain = async (): Promise<CreditDomainResponse> => {
    if (domainCache) return domainCache;
    const parsed = await postJson<CreditDomainResponse>(
      fetchImpl,
      `${endpoint}${RELAYER_ROUTES.creditDomain}`,
      undefined,
      { errorPrefix: 'failed to fetch credit domain' }
    );
    domainCache = parsed;
    return parsed;
  };

  const resolveChannelId = async (): Promise<CreditChannelId> => {
    if (resolvedChannelId) return resolvedChannelId;
    const currentDomain = await getDomain();
    resolvedChannelId = deriveCreditChannelId({
      domain: currentDomain,
      agentAddress
    });
    return resolvedChannelId;
  };

  const getLatestState = (): SignedCreditState | undefined => {
    if (!resolvedChannelId) return undefined;
    return config.stateStore?.getCreditState(resolvedChannelId);
  };

  const persistState = async (domain: CreditDomainResponse, state: CreditState, relayerSignature: Hex) => {
    const relayerSigner = await recoverCreditStateSigner(domain, state, relayerSignature);
    if (relayerSigner !== domain.relayerAddress.toLowerCase()) {
      throw new Error('relayer signature does not match advertised relayer address');
    }
    const agentSignature = await signAgentCreditState(domain, state, config.signer);
    const signed: SignedCreditState = {
      state,
      agentSignature,
      relayerSignature
    };
    await config.stateStore?.setCreditState(signed);
    return signed;
  };

  const topup = async (
    request: Omit<RelayerCreditTopupRequest, 'channelId' | 'latestState'>
  ): Promise<RelayerCreditTopupResponse> => {
    const domain = await getDomain();
    const channelId = await resolveChannelId();
    const latestState = config.stateStore?.getCreditState(channelId);
    const payload: RelayerCreditTopupRequest = {
      ...request,
      channelId
    };
    if (latestState) {
      payload.latestState = latestState;
    }
    const result = await postJson<RelayerCreditTopupResponse>(
      fetchImpl,
      `${endpoint}${RELAYER_ROUTES.creditTopup}`,
      payload,
      { allowNonOk: true }
    );
    if (result.status === 'DONE') {
      if (!result.nextState || !result.nextStateRelayerSignature) {
        throw new Error('credit topup succeeded without next state signatures');
      }
      await persistState(domain, result.nextState, result.nextStateRelayerSignature);
    }
    return result;
  };

  const pay = async (args: CreditPayArgs): Promise<RelayerCreditPayResponse> => {
    const run = async (): Promise<RelayerCreditPayResponse> => {
      const domain = await getDomain();
      const channelId = await resolveChannelId();
      const latestState = config.stateStore?.getCreditState(channelId);
      if (!latestState) {
        throw new Error('missing latest credit state; top up first');
      }

      const normalizedRequirement = normalizeRequirement(args.requirement);
      const amount = BigInt(normalizedRequirement.amount);
      if (BigInt(latestState.state.available) < amount) {
        throw new Error('insufficient credit balance for request amount');
      }

      const requestId = assertNonEmpty(args.requestId, 'requestId');
      const deadline = nowSeconds() + BigInt(args.deadlineSeconds ?? 120);
      const debitIntent = {
        channelId,
        prevStateHash: hashCreditState(latestState.state),
        nextSeq: (BigInt(latestState.state.seq) + 1n).toString(),
        amount: amount.toString(),
        merchantRequestHash: canonicalMerchantRequestHash({
          merchantRequest: args.merchantRequest,
          requirement: normalizedRequirement
        }),
        deadline: deadline.toString(),
        requestId
      };
      const debitIntentSignature = await signDebitIntent(domain, debitIntent, config.signer);

      const request: RelayerCreditPayRequest = {
        requestId,
        merchantRequest: args.merchantRequest,
        requirement: normalizedRequirement,
        latestState,
        debitIntent,
        debitIntentSignature
      };

      const result = await postJson<RelayerCreditPayResponse>(
        fetchImpl,
        `${endpoint}${RELAYER_ROUTES.creditPay}`,
        request,
        { allowNonOk: true }
      );
      if (result.status === 'DONE') {
        if (!result.nextState || !result.nextStateRelayerSignature) {
          throw new Error('credit pay succeeded without next state signatures');
        }
        await persistState(domain, result.nextState, result.nextStateRelayerSignature);
      }
      return result;
    };

    const resultPromise = payQueue.then(run, run);
    // Sequential queue: enforce one in-flight pay per channel state.
    payQueue = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  };

  return {
    getDomain,
    getChannelId: resolveChannelId,
    getLatestState,
    topup,
    pay
  };
}
