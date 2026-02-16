import {
  encodeX402Header,
  parsePaymentRequiredEnvelope,
  parsePaymentRequiredHeader,
  RELAYER_ROUTES,
  X402_HEADERS,
  type Hex,
  type PaymentRequirement,
  type X402PaymentRequired,
  type RelayerChallengeRequest,
  type RelayerChallengeResponse,
  type RelayerPayRequest,
  type RelayerPayResponse,
  type ShieldedNote
} from '@shielded-x402/shared-types';
import { ShieldedClientSDK } from './client.js';
import type { Prepared402Payment } from './types.js';
import type { MerkleWitness } from './merkle.js';

export interface RelayedShieldedFetchContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
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
  relayerChallengePath?: string;
  resolveContext: (args: ResolveRelayedContextArgs) => Promise<RelayedShieldedFetchContext>;
  challengeUrlResolver?: (args: { input: string; requirement?: PaymentRequirement }) => string | undefined;
  onUnsupportedRail?: (args: UnsupportedRelayedRailArgs) => Promise<Response>;
  onSettlement?: (args: {
    relayResponse: RelayerPayResponse;
    prepared: Prepared402Payment;
    context: RelayedShieldedFetchContext;
    requirement: PaymentRequirement;
  }) => Promise<void> | void;
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

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function serializedToFetchInit(
  method: string,
  serialized: { headers: Record<string, string>; bodyBase64?: string }
): RequestInit {
  const init: RequestInit = {
    method,
    headers: serialized.headers
  };
  if (method !== 'GET' && method !== 'HEAD' && serialized.bodyBase64 !== undefined) {
    init.body = Buffer.from(serialized.bodyBase64, 'base64');
  }
  return init;
}

async function requestShieldedRequirementFromRelayer(
  baseFetch: typeof fetch,
  relayerEndpoint: string,
  relayerChallengePath: string,
  merchantRequest: RelayerChallengeRequest['merchantRequest'],
  merchantPaymentRequiredHeader?: string
): Promise<PaymentRequirement> {
  const challengeRequest: RelayerChallengeRequest = {
    merchantRequest,
    ...(merchantPaymentRequiredHeader ? { merchantPaymentRequiredHeader } : {})
  };

  const response = await baseFetch(`${relayerEndpoint.replace(/\/$/, '')}${relayerChallengePath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(challengeRequest)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`relayer challenge request failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as RelayerChallengeResponse;
  if (payload.requirement) {
    return payload.requirement;
  }
  if (payload.paymentRequiredHeader) {
    return parsePaymentRequiredHeader(payload.paymentRequiredHeader);
  }
  throw new Error('relayer challenge response missing requirement');
}

async function serializeMerchantRequestBody(
  method: string,
  headers: HeadersInit | undefined,
  body: BodyInit | null | undefined
): Promise<{ headers: Record<string, string>; bodyBase64?: string }> {
  const normalizedMethod = method.toUpperCase();
  const supportsBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
  const requestInit: RequestInit = {
    method: normalizedMethod
  };
  if (headers !== undefined) {
    requestInit.headers = headers;
  }
  if (supportsBody && body !== undefined && body !== null) {
    requestInit.body = body;
  }
  const request = new Request('http://relay.local', requestInit);

  const serializedHeaders = headersToRecord(request.headers);
  if (!supportsBody || body === undefined || body === null) {
    return { headers: serializedHeaders };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  return {
    headers: serializedHeaders,
    bodyBase64: bytesToBase64(bytes)
  };
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

  return new Response(Buffer.from(relayResponse.merchantResult.bodyBase64, 'base64'), {
    status: relayResponse.merchantResult.status,
    headers: {
      ...relayResponse.merchantResult.headers,
      ...settlementIdHeader
    }
  });
}

function getRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getIntegerString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed)) && Number(trimmed) >= 0) {
      return Math.trunc(Number(trimmed)).toString();
    }
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString();
  }
  return undefined;
}

function normalizeRequirementLike(
  input: Record<string, unknown>,
  fallbackResource: string
): Record<string, unknown> | undefined {
  const extra = getRecord(input.extra);
  const scheme = (getString(input, 'scheme') ?? getString(extra ?? {}, 'scheme') ?? 'exact').toLowerCase();
  const network = getString(input, 'network') ?? getString(extra ?? {}, 'network');
  const payTo = getString(input, 'payTo') ?? getString(input, 'to') ?? getString(extra ?? {}, 'payTo');
  const asset = getString(input, 'asset') ?? getString(extra ?? {}, 'asset');
  const amount =
    getIntegerString(input, 'amount') ??
    getIntegerString(input, 'maxAmountRequired') ??
    getIntegerString(extra ?? {}, 'amount') ??
    getIntegerString(extra ?? {}, 'maxAmountRequired');

  if (!scheme || !network || !payTo || !asset || !amount) return undefined;

  const normalized: Record<string, unknown> = {
    scheme,
    network,
    amount,
    payTo,
    asset
  };
  normalized.resource = getString(input, 'resource') ?? getString(extra ?? {}, 'resource') ?? fallbackResource;
  const description = getString(input, 'description') ?? getString(extra ?? {}, 'description');
  if (description) normalized.description = description;
  const mimeType = getString(input, 'mimeType') ?? getString(extra ?? {}, 'mimeType');
  if (mimeType) normalized.mimeType = mimeType;
  const rail = getString(input, 'rail') ?? getString(extra ?? {}, 'rail');
  const challengeNonce =
    getString(input, 'challengeNonce') ?? getString(extra ?? {}, 'challengeNonce');
  const challengeExpiry =
    getString(input, 'challengeExpiry') ?? getString(extra ?? {}, 'challengeExpiry');
  const merchantPubKey =
    getString(input, 'merchantPubKey') ?? getString(extra ?? {}, 'merchantPubKey');
  const verifyingContract =
    getString(input, 'verifyingContract') ?? getString(extra ?? {}, 'verifyingContract');
  if (rail && challengeNonce && challengeExpiry && merchantPubKey && verifyingContract) {
    normalized.rail = rail;
    normalized.challengeNonce = challengeNonce;
    normalized.challengeExpiry = challengeExpiry;
    normalized.merchantPubKey = merchantPubKey;
    normalized.verifyingContract = verifyingContract;
  }
  const maxTimeoutSeconds = input.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds)) {
    normalized.maxTimeoutSeconds = Math.trunc(maxTimeoutSeconds);
  }
  if (input.outputSchema !== undefined) normalized.outputSchema = input.outputSchema;
  if (extra) normalized.extra = extra;
  return normalized;
}

async function resolvePaymentRequiredHeader(
  response: Response,
  fallbackResource: string
): Promise<string | undefined> {
  const directHeader = response.headers.get(X402_HEADERS.paymentRequired);
  if (directHeader) return directHeader;

  let bodyRecord: Record<string, unknown> | undefined;
  try {
    bodyRecord = getRecord((await response.clone().json()) as unknown);
  } catch {
    bodyRecord = undefined;
  }
  if (!bodyRecord) return undefined;

  const candidates: unknown[] = [];
  if (Array.isArray(bodyRecord.accepts)) candidates.push(...bodyRecord.accepts);
  if (Array.isArray(bodyRecord.requirements)) candidates.push(...bodyRecord.requirements);
  if (candidates.length === 0) candidates.push(bodyRecord);

  const normalizedAccept = candidates
    .map((entry) => getRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => normalizeRequirementLike(entry, fallbackResource))
    .find((entry): entry is Record<string, unknown> => Boolean(entry));
  if (!normalizedAccept) return undefined;

  const envelope: X402PaymentRequired = {
    x402Version: 2,
    accepts: [normalizedAccept],
    ...(typeof bodyRecord.error === 'string' ? { error: bodyRecord.error } : {})
  };
  return encodeX402Header(envelope);
}

export function createRelayedShieldedFetch(config: CreateRelayedShieldedFetchConfig): RelayedShieldedFetch {
  const baseFetch = config.fetchImpl ?? fetch;
  const relayerPath = config.relayerPath ?? RELAYER_ROUTES.pay;
  const relayerChallengePath = config.relayerChallengePath ?? RELAYER_ROUTES.challenge;

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput = normalizeInput(input);
    const requestInit: RequestInit = init ?? {};
    const method = (requestInit.method ?? 'GET').toUpperCase();
    const serializedRequest = await serializeMerchantRequestBody(
      method,
      requestInit.headers,
      requestInit.body
    );
    const baseMerchantRequest = {
      url: normalizedInput,
      method,
      headers: serializedRequest.headers,
      ...(serializedRequest.bodyBase64 !== undefined
        ? { bodyBase64: serializedRequest.bodyBase64 }
        : {})
    };

    const first = await baseFetch(normalizedInput, serializedToFetchInit(method, serializedRequest));
    if (first.status !== 402) return first;
    const merchantRequiredHeader = await resolvePaymentRequiredHeader(first, normalizedInput);
    if (!merchantRequiredHeader) {
      throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
    }
    parsePaymentRequiredEnvelope(merchantRequiredHeader);

    let requirement: PaymentRequirement;
    let parsedRequirement: PaymentRequirement | undefined;
    try {
      parsedRequirement = parsePaymentRequiredHeader(merchantRequiredHeader);
    } catch {
      parsedRequirement = undefined;
    }

    if (parsedRequirement?.rail === 'shielded-usdc') {
      requirement = parsedRequirement;
    } else {
      const challengeUrl = config.challengeUrlResolver?.(
        parsedRequirement
          ? {
              input: normalizedInput,
              requirement: parsedRequirement
            }
          : {
              input: normalizedInput
            }
      );
      try {
        requirement = await requestShieldedRequirementFromRelayer(
          baseFetch,
          config.relayerEndpoint,
          relayerChallengePath,
          {
            ...baseMerchantRequest,
            ...(challengeUrl ? { challengeUrl } : {})
          },
          merchantRequiredHeader
        );
      } catch (error) {
        if (parsedRequirement && config.onUnsupportedRail) {
          return config.onUnsupportedRail({
            input: normalizedInput,
            init: requestInit,
            requirement: parsedRequirement,
            challengeResponse: first
          });
        }
        throw error;
      }
    }

    const context = await config.resolveContext({
      input: normalizedInput,
      init: requestInit,
      requirement,
      challengeResponse: first
    });
    const prepared = await config.sdk.prepare402Payment(
      requirement,
      context.note,
      context.witness,
      context.nullifierSecret,
      serializedRequest.headers
    );

    const paymentSignatureHeader = prepared.headers.get(X402_HEADERS.paymentSignature);
    if (!paymentSignatureHeader) {
      throw new Error('failed to build relayer payment headers');
    }

    const challengeUrl = config.challengeUrlResolver?.({
      input: normalizedInput,
      requirement
    });
    const relayRequest: RelayerPayRequest = {
      merchantRequest: {
        ...baseMerchantRequest,
        ...(challengeUrl ? { challengeUrl } : {})
      },
      requirement,
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
    if (config.onSettlement) {
      await config.onSettlement({
        relayResponse: relayPayload,
        prepared,
        context,
        requirement
      });
    }
    return toRelayResultResponse(relayPayload);
  };
}
