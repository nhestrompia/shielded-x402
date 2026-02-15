import {
  RELAYER_ROUTES,
  X402_HEADERS,
  type Hex,
  type PaymentRequirement,
  type RelayerPayRequest,
  type RelayerPayResponse,
  type ShieldedNote
} from '@shielded-x402/shared-types';
import { ShieldedClientSDK } from './client.js';
import type { MerkleWitness } from './merkle.js';

export interface RelayedShieldedFetchContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  payerPkHash: Hex;
}

export interface ResolveRelayedContextArgs {
  input: string;
  init: RequestInit;
  requirement: PaymentRequirement;
  challengeResponse: Response;
}

export interface UnsupportedRelayedRailArgs {
  input: string;
  init: RequestInit;
  requirement: PaymentRequirement;
  challengeResponse: Response;
}

export interface CreateRelayedShieldedFetchConfig {
  sdk: ShieldedClientSDK;
  relayerEndpoint: string;
  relayerPath?: string;
  resolveContext: (args: ResolveRelayedContextArgs) => Promise<RelayedShieldedFetchContext>;
  challengeUrlResolver?: (args: { input: string; requirement: PaymentRequirement }) => string | undefined;
  onUnsupportedRail?: (args: UnsupportedRelayedRailArgs) => Promise<Response>;
  fetchImpl?: typeof fetch;
}

export type RelayedShieldedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizeInput(input: string | URL): string {
  if (typeof input === 'string') return input;
  return input.toString();
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const cast = new Headers(headers);
  cast.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeBody(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('relayed shielded fetch currently supports string/URLSearchParams request bodies only');
}

function toRelayResultResponse(relayResponse: RelayerPayResponse): Response {
  const settlementIdHeader = { 'x-relayer-settlement-id': relayResponse.settlementId };
  if (!relayResponse.merchantResult) {
    const status = relayResponse.status === 'DONE' ? 200 : 502;
    return new Response(JSON.stringify(relayResponse), {
      status,
      headers: {
        ...settlementIdHeader,
        'content-type': 'application/json'
      }
    });
  }

  return new Response(relayResponse.merchantResult.body, {
    status: relayResponse.merchantResult.status,
    headers: {
      ...relayResponse.merchantResult.headers,
      ...settlementIdHeader
    }
  });
}

export function createRelayedShieldedFetch(config: CreateRelayedShieldedFetchConfig): RelayedShieldedFetch {
  const baseFetch = config.fetchImpl ?? fetch;
  const relayerPath = config.relayerPath ?? RELAYER_ROUTES.pay;

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput = normalizeInput(input);
    const requestInit: RequestInit = init ?? {};

    const first = await baseFetch(normalizedInput, requestInit);
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
    const prepared = await config.sdk.prepare402Payment(
      parsed.requirement,
      context.note,
      context.witness,
      context.payerPkHash,
      requestInit.headers
    );

    const paymentSignatureHeader = prepared.headers.get(X402_HEADERS.paymentSignature);
    if (!paymentSignatureHeader) {
      throw new Error('failed to build relayer payment headers');
    }

    const challengeUrl = config.challengeUrlResolver?.({
      input: normalizedInput,
      requirement: parsed.requirement
    });
    const body = normalizeBody(requestInit.body);
    const relayRequest: RelayerPayRequest = {
      merchantRequest: {
        url: normalizedInput,
        method: requestInit.method ?? 'GET',
        headers: headersToRecord(requestInit.headers),
        ...(body !== undefined ? { body } : {}),
        ...(challengeUrl ? { challengeUrl } : {})
      },
      requirement: parsed.requirement,
      paymentSignatureHeader
    };

    const relayerResponse = await baseFetch(`${config.relayerEndpoint.replace(/\/$/, '')}${relayerPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(relayRequest)
    });

    const relayPayload = (await relayerResponse.json()) as RelayerPayResponse;
    return toRelayResultResponse(relayPayload);
  };
}
