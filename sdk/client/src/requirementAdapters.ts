import {
  X402_HEADERS,
  encodeX402Header,
  parsePaymentRequiredEnvelope,
  parsePaymentRequiredHeader,
  type PaymentRequirement,
  type RequirementAdapterContext
} from '@shielded-x402/shared-types';

export interface RequirementAdapter {
  name: string;
  matches?: (ctx: RequirementAdapterContext) => boolean;
  normalizeIncoming402?: (response: Response, ctx: RequirementAdapterContext) => Promise<Response>;
  normalizeRequirementLike?: (
    value: Record<string, unknown>,
    ctx: RequirementAdapterContext
  ) => Record<string, unknown> | undefined;
  rewriteOutgoingPaymentHeaders?: (headers: Headers, ctx: RequirementAdapterContext) => HeadersInit;
}

function normalizeRequirementLikeGeneric(
  value: Record<string, unknown>,
  ctx: RequirementAdapterContext
): Record<string, unknown> | undefined {
  const extra = getRecord(value.extra);
  const scheme = (getString(value, 'scheme') ?? getString(extra ?? {}, 'scheme') ?? 'exact').toLowerCase();
  const network = getString(value, 'network') ?? getString(extra ?? {}, 'network');
  const payTo = getString(value, 'payTo') ?? getString(value, 'to') ?? getString(extra ?? {}, 'payTo');
  const asset = getString(value, 'asset') ?? getString(extra ?? {}, 'asset');
  const amount =
    getIntegerString(value, 'amount') ??
    getIntegerString(value, 'maxAmountRequired') ??
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
  normalized.resource =
    getString(value, 'resource') ?? getString(extra ?? {}, 'resource') ?? ctx.requestUrl;

  const description = getString(value, 'description') ?? getString(extra ?? {}, 'description');
  if (description) normalized.description = description;
  const mimeType = getString(value, 'mimeType') ?? getString(extra ?? {}, 'mimeType');
  if (mimeType) normalized.mimeType = mimeType;
  const maxTimeoutSeconds = value.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds)) {
    normalized.maxTimeoutSeconds = Math.trunc(maxTimeoutSeconds);
  }
  if (value.outputSchema !== undefined) normalized.outputSchema = value.outputSchema;
  const rail = getString(value, 'rail') ?? getString(extra ?? {}, 'rail');
  const challengeNonce =
    getString(value, 'challengeNonce') ?? getString(extra ?? {}, 'challengeNonce');
  const challengeExpiry =
    getString(value, 'challengeExpiry') ?? getString(extra ?? {}, 'challengeExpiry');
  const merchantPubKey =
    getString(value, 'merchantPubKey') ?? getString(extra ?? {}, 'merchantPubKey');
  const verifyingContract =
    getString(value, 'verifyingContract') ?? getString(extra ?? {}, 'verifyingContract');
  if (rail && challengeNonce && challengeExpiry && merchantPubKey && verifyingContract) {
    normalized.rail = rail;
    normalized.challengeNonce = challengeNonce;
    normalized.challengeExpiry = challengeExpiry;
    normalized.merchantPubKey = merchantPubKey;
    normalized.verifyingContract = verifyingContract;
  }
  if (extra) normalized.extra = extra;
  return normalized;
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

function matchingAdapters(
  adapters: RequirementAdapter[],
  ctx: RequirementAdapterContext
): RequirementAdapter[] {
  return adapters.filter((adapter) => !adapter.matches || adapter.matches(ctx));
}

function normalizeRequirementLikeWithAdapters(
  candidate: Record<string, unknown>,
  ctx: RequirementAdapterContext,
  adapters: RequirementAdapter[]
): Record<string, unknown> | undefined {
  for (const adapter of matchingAdapters(adapters, ctx)) {
    if (!adapter.normalizeRequirementLike) continue;
    const normalized = adapter.normalizeRequirementLike(candidate, ctx);
    if (normalized) return normalized;
  }
  return undefined;
}

function withHeader(response: Response, headerValue: string): Response {
  const headers = new Headers(response.headers);
  headers.set(X402_HEADERS.paymentRequired, headerValue);
  if (!headers.get('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function createGenericX402V2Adapter(): RequirementAdapter {
  return {
    name: 'generic-x402-v2',

    normalizeRequirementLike: (
      value: Record<string, unknown>,
      ctx: RequirementAdapterContext
    ): Record<string, unknown> | undefined => normalizeRequirementLikeGeneric(value, ctx),

    normalizeIncoming402: async (response: Response, ctx: RequirementAdapterContext): Promise<Response> => {
      if (response.status !== 402) return response;
      const directHeader = response.headers.get(X402_HEADERS.paymentRequired);
      if (directHeader) {
        parsePaymentRequiredEnvelope(directHeader);
        return response;
      }

      const bodyText = await response.text();
      if (bodyText.length === 0) return response;
      let bodyRecord: Record<string, unknown> | undefined;
      try {
        bodyRecord = getRecord(JSON.parse(bodyText) as unknown);
      } catch {
        bodyRecord = undefined;
      }
      if (!bodyRecord) return response;

      const candidates: unknown[] = [];
      if (Array.isArray(bodyRecord.accepts)) candidates.push(...bodyRecord.accepts);
      if (Array.isArray(bodyRecord.requirements)) candidates.push(...bodyRecord.requirements);
      if (candidates.length === 0) candidates.push(bodyRecord);

      const normalized = candidates
        .map((entry) => getRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => normalizeRequirementLikeGeneric(entry, ctx))
        .find((entry): entry is Record<string, unknown> => Boolean(entry));

      if (!normalized) {
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers)
        });
      }

      const envelope = {
        x402Version: 2 as const,
        accepts: [normalized],
        ...(typeof bodyRecord.error === 'string' ? { error: bodyRecord.error } : {})
      };
      const headerValue = encodeX402Header(envelope);
      const headers = new Headers(response.headers);
      headers.set(X402_HEADERS.paymentRequired, headerValue);
      headers.set('content-type', 'application/json');
      return new Response(JSON.stringify(envelope), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
  };
}

export async function normalizeIncoming402WithAdapters(
  response: Response,
  ctx: RequirementAdapterContext,
  adapters: RequirementAdapter[]
): Promise<Response> {
  let current = response;
  for (const adapter of matchingAdapters(adapters, ctx)) {
    if (!adapter.normalizeIncoming402) continue;
    try {
      const next = await adapter.normalizeIncoming402(current, ctx);
      if (next !== current) {
        current = next;
        break;
      }
      current = next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`requirement adapter ${adapter.name} normalizeIncoming402 failed: ${message}`);
    }
  }
  return current;
}

export function rewriteOutgoingHeadersWithAdapters(
  headers: Headers,
  ctx: RequirementAdapterContext,
  adapters: RequirementAdapter[]
): Headers {
  let out = new Headers(headers);
  for (const adapter of matchingAdapters(adapters, ctx)) {
    if (!adapter.rewriteOutgoingPaymentHeaders) continue;
    try {
      out = new Headers(adapter.rewriteOutgoingPaymentHeaders(out, ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `requirement adapter ${adapter.name} rewriteOutgoingPaymentHeaders failed: ${message}`
      );
    }
  }
  return out;
}

export async function parseRequirementFrom402Response(
  response: Response,
  ctx: RequirementAdapterContext,
  adapters: RequirementAdapter[]
): Promise<{ response: Response; requirement: PaymentRequirement }> {
  const normalized = await normalizeIncoming402WithAdapters(response, ctx, adapters);
  const header = normalized.headers.get(X402_HEADERS.paymentRequired);
  if (header) {
    return {
      response: normalized,
      requirement: parsePaymentRequiredHeader(header)
    };
  }

  let bodyRecord: Record<string, unknown> | undefined;
  try {
    bodyRecord = getRecord((await normalized.clone().json()) as unknown);
  } catch {
    bodyRecord = undefined;
  }
  if (!bodyRecord) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }

  const candidates: unknown[] = [];
  if (Array.isArray(bodyRecord.accepts)) candidates.push(...bodyRecord.accepts);
  if (Array.isArray(bodyRecord.requirements)) candidates.push(...bodyRecord.requirements);
  if (candidates.length === 0) candidates.push(bodyRecord);

  const normalizedRequirement = candidates
    .map((entry) => getRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => normalizeRequirementLikeWithAdapters(entry, ctx, adapters))
    .find((entry): entry is Record<string, unknown> => Boolean(entry));

  if (!normalizedRequirement) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }

  const envelope = {
    x402Version: 2 as const,
    accepts: [normalizedRequirement],
    ...(typeof bodyRecord.error === 'string' ? { error: bodyRecord.error } : {})
  };
  const headerValue = encodeX402Header(envelope);
  const withRequiredHeader = withHeader(normalized, headerValue);

  return {
    response: withRequiredHeader,
    requirement: parsePaymentRequiredHeader(headerValue)
  };
}
