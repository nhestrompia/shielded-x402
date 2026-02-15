import {
  X402_HEADERS,
  buildPaymentRequiredHeader,
  type Hex,
  type PaymentRequirement,
  type ShieldedNote
} from '@shielded-x402/shared-types';
import { ShieldedClientSDK } from './client.js';
import type { MerkleWitness } from './merkle.js';

export interface ShieldedFetchContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  payerPkHash: Hex;
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
}

export type ShieldedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const normalizeInput = (input: string | URL): string => {
  if (typeof input === 'string') return input;
  return input.toString();
};

export function createShieldedFetch(config: CreateShieldedFetchConfig): ShieldedFetch {
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
          context.payerPkHash,
          requestInit.headers
        );
        first = await baseFetch(normalizedInput, {
          ...requestInit,
          headers: prepared.headers
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
    const parsed = config.sdk.parse402Response(first);
    if (parsed.requirement.rail !== 'shielded-usdc') {
      if (config.onUnsupportedRail) {
        return config.onUnsupportedRail({
          input: normalizedInput,
          init: requestInit,
          requirement: parsed.requirement,
          challengeResponse: first
        });
      }
      return first;
    }

    const context = await config.resolveContext({
      input: normalizedInput,
      init: requestInit,
      requirement: parsed.requirement,
      challengeResponse: first
    });

    return config.sdk.complete402Payment(
      normalizedInput,
      requestInit,
      parsed.requirement,
      context.note,
      context.witness,
      context.payerPkHash,
      baseFetch
    );
  };
}
