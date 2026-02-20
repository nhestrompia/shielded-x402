import {
  headersInitToRecord,
  normalizeRequestInput,
  type PaymentRequirement,
  type RelayerMerchantRequest
} from '@shielded-x402/shared-types';
import { createGenericX402V2Adapter, parseRequirementFrom402Response } from './requirementAdapters.js';
import type { CreditPayArgs } from './creditChannel.js';

export interface CreditPayClient {
  pay: (args: CreditPayArgs) => Promise<{
    status: 'DONE' | 'FAILED';
    merchantResult?: {
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    };
    failureReason?: string;
  }>;
}

export interface CreateCreditFetchConfig {
  creditClient: CreditPayClient;
  fetchImpl?: typeof fetch;
}

async function serializeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  const request = new Request('http://credit.local', {
    method: 'POST',
    body
  });
  const bytes = new Uint8Array(await request.arrayBuffer());
  return Buffer.from(bytes).toString('base64');
}

function toResponse(merchantResult: {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}): Response {
  return new Response(Buffer.from(merchantResult.bodyBase64, 'base64'), {
    status: merchantResult.status,
    headers: merchantResult.headers
  });
}

function buildRequestId(requirement: PaymentRequirement, url: string): string {
  const now = Date.now().toString(16);
  return `credit-${now}-${requirement.challengeNonce.slice(2, 10)}-${Buffer.from(url).toString('hex').slice(0, 8)}`;
}

export function createCreditShieldedFetch(config: CreateCreditFetchConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const requirementAdapters = [createGenericX402V2Adapter()];

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput = normalizeRequestInput(input);
    const requestInit: RequestInit = init ?? {};
    const first = await fetchImpl(normalizedInput, requestInit);
    if (first.status !== 402) return first;

    const { requirement } = await parseRequirementFrom402Response(
      first,
      { requestUrl: normalizedInput },
      requirementAdapters
    );
    const method = (requestInit.method ?? 'GET').toUpperCase();
    const bodyBase64 =
      method !== 'GET' && method !== 'HEAD'
        ? await serializeBody(requestInit.body ?? null)
        : undefined;
    const merchantRequest: RelayerMerchantRequest = {
      url: normalizedInput,
      method,
      headers: headersInitToRecord(requestInit.headers)
    };
    if (bodyBase64 !== undefined) {
      merchantRequest.bodyBase64 = bodyBase64;
    }

    const creditResult = await config.creditClient.pay({
      requestId: buildRequestId(requirement, normalizedInput),
      merchantRequest,
      requirement
    });
    if (creditResult.status !== 'DONE' || !creditResult.merchantResult) {
      throw new Error(creditResult.failureReason ?? 'credit pay failed');
    }
    return toResponse(creditResult.merchantResult);
  };
}
