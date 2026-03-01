import type { Hex, PaymentRequirement, ShieldedNote } from '@shielded-x402/shared-types';
import type { ShieldedClientSDK } from './client.js';
import type { MerkleWitness } from './merkle.js';
import {
  createGenericX402V2Adapter,
  parseRequirementFrom402Response,
  rewriteOutgoingHeadersWithAdapters,
  type RequirementAdapter
} from './requirementAdapters.js';

export interface ShieldedSpendContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
}

export interface ShieldedPaymentBuilder {
  prepare402Payment: ShieldedClientSDK['prepare402Payment'];
}

export interface ResolveShieldedContextInput {
  request: Request;
  requirement: PaymentRequirement;
  paymentRequiredResponse: Response;
}

export interface CreateShieldedFetchOptions {
  sdk: ShieldedPaymentBuilder;
  resolveContext: (input: ResolveShieldedContextInput) => Promise<ShieldedSpendContext>;
  adapters?: RequirementAdapter[];
  fetchFn?: typeof fetch;
}

export type ShieldedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createShieldedFetch(options: CreateShieldedFetchOptions): ShieldedFetch {
  const fetchFn = options.fetchFn ?? fetch;
  const adapters = options.adapters ?? [createGenericX402V2Adapter()];

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const firstResponse = await fetchFn(request.clone());
    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    const { response: normalized402, requirement } = await parseRequirementFrom402Response(
      firstResponse,
      { requestUrl: request.url },
      adapters
    );

    const spendContext = await options.resolveContext({
      request,
      requirement,
      paymentRequiredResponse: normalized402
    });

    const prepared = await options.sdk.prepare402Payment(
      requirement,
      spendContext.note,
      spendContext.witness,
      spendContext.nullifierSecret,
      request.headers
    );

    const outgoingHeaders = rewriteOutgoingHeadersWithAdapters(
      prepared.headers,
      { requestUrl: request.url },
      adapters
    );

    const retryRequest = new Request(request, { headers: outgoingHeaders });
    return fetchFn(retryRequest);
  };
}
