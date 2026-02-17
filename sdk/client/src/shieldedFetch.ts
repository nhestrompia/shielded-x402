import {
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type Hex,
  type PaymentRequirement,
  type ShieldedNote
} from '@shielded-x402/shared-types';
import { ShieldedClientSDK } from './client.js';
import type { MerkleWitness } from './merkle.js';
import {
  createRelayedShieldedFetch,
  type CreateRelayedShieldedFetchConfig
} from './relayerFetch.js';
import {
  createGenericX402V2Adapter,
  parseRequirementFrom402Response,
  rewriteOutgoingHeadersWithAdapters,
  type RequirementAdapter
} from './requirementAdapters.js';

export interface ShieldedFetchContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
}

export interface ResolveShieldedContextArgs {
  input: string;
  init: RequestInit;
  requirement: PaymentRequirement;
  challengeResponse: Response;
}

export interface UnsupportedRailArgs {
  input: string;
  init: RequestInit;
  requirement: PaymentRequirement;
  challengeResponse: Response;
}

export interface CreateShieldedFetchConfig {
  sdk: ShieldedClientSDK;
  resolveContext: (args: ResolveShieldedContextArgs) => Promise<ShieldedFetchContext>;
  onUnsupportedRail?: (args: UnsupportedRailArgs) => Promise<Response>;
  prefetchRequirement?: (args: { input: string; init: RequestInit }) => Promise<PaymentRequirement | null>;
  fetchImpl?: typeof fetch;
  relayerEndpoint?: string;
  relayerPath?: string;
  challengeUrlResolver?: (args: { input: string; requirement?: PaymentRequirement }) => string | undefined;
  onRelayerSettlement?: CreateRelayedShieldedFetchConfig['onSettlement'];
  requirementAdapters?: RequirementAdapter[];
}

export type ShieldedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const normalizeInput = (input: string | URL): string => {
  if (typeof input === 'string') return input;
  return input.toString();
};

export function createShieldedFetch(config: CreateShieldedFetchConfig): ShieldedFetch {
  const requirementAdapters = config.requirementAdapters ?? [createGenericX402V2Adapter()];
  if (config.relayerEndpoint) {
    const relayedConfig: CreateRelayedShieldedFetchConfig = {
      sdk: config.sdk,
      relayerEndpoint: config.relayerEndpoint,
      resolveContext: config.resolveContext,
      requirementAdapters
    };
    if (config.onUnsupportedRail) {
      relayedConfig.onUnsupportedRail = config.onUnsupportedRail;
    }
    if (config.relayerPath) {
      relayedConfig.relayerPath = config.relayerPath;
    }
    if (config.fetchImpl) {
      relayedConfig.fetchImpl = config.fetchImpl;
    }
    if (config.challengeUrlResolver) {
      relayedConfig.challengeUrlResolver = config.challengeUrlResolver;
    }
    if (config.onRelayerSettlement) {
      relayedConfig.onSettlement = config.onRelayerSettlement;
    }
    return createRelayedShieldedFetch(relayedConfig);
  }

  const baseFetch = config.fetchImpl ?? fetch;
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput = normalizeInput(input);
    const requestInit: RequestInit = init ?? {};
    let first: Response | null = null;

    if (config.prefetchRequirement) {
      const prefetched = await config.prefetchRequirement({
        input: normalizedInput,
        init: requestInit
      });
      if (prefetched?.rail === 'shielded-usdc') {
        const syntheticChallenge = new Response(null, {
          status: 402,
          headers: {
            [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(prefetched)
          }
        });
        const context = await config.resolveContext({
          input: normalizedInput,
          init: requestInit,
          requirement: prefetched,
          challengeResponse: syntheticChallenge
        });
        const prepared = await config.sdk.prepare402Payment(
          prefetched,
          context.note,
          context.witness,
          context.nullifierSecret,
          requestInit.headers
        );
        const rewrittenHeaders = rewriteOutgoingHeadersWithAdapters(
          new Headers(prepared.headers),
          { requestUrl: normalizedInput },
          requirementAdapters
        );
        first = await baseFetch(normalizedInput, {
          ...requestInit,
          headers: rewrittenHeaders
        });
        if (first.status !== 402) {
          return first;
        }
      }
    }

    if (!first) {
      first = await baseFetch(normalizedInput, requestInit);
    }
    if (first.status !== 402) return first;
    const { response: normalizedChallenge, requirement } = await parseRequirementFrom402Response(
      first,
      { requestUrl: normalizedInput },
      requirementAdapters
    );
    if (requirement.rail !== 'shielded-usdc') {
      if (config.onUnsupportedRail) {
        return config.onUnsupportedRail({
          input: normalizedInput,
          init: requestInit,
          requirement,
          challengeResponse: normalizedChallenge
        });
      }
      return normalizedChallenge;
    }

    const context = await config.resolveContext({
      input: normalizedInput,
      init: requestInit,
      requirement,
      challengeResponse: normalizedChallenge
    });

    const prepared = await config.sdk.prepare402Payment(
      requirement,
      context.note,
      context.witness,
      context.nullifierSecret,
      requestInit.headers
    );
    const rewrittenHeaders = rewriteOutgoingHeadersWithAdapters(
      new Headers(prepared.headers),
      { requestUrl: normalizedInput },
      requirementAdapters
    );
    return baseFetch(normalizedInput, {
      ...requestInit,
      headers: rewrittenHeaders
    });
  };
}
