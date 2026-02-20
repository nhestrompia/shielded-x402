import {
  X402_HEADERS,
  encodeX402Header,
  getIntegerStringFromRecords,
  getRecord,
  getString,
  getStringFromRecords,
  parsePaymentRequiredEnvelope,
  parsePaymentRequiredHeader,
  type PaymentRequirement,
  type RequirementAdapterContext
} from '@shielded-x402/shared-types';

const ZERO_BYTES32 = (`0x${'0'.repeat(64)}` as const);
const ZERO_ADDRESS = (`0x${'0'.repeat(40)}` as const);
const ZERO_ASSET = (`0x${'0'.repeat(64)}` as const);

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
  const scheme = (getStringFromRecords('scheme', value, extra) ?? 'exact').toLowerCase();
  const network =
    getStringFromRecords('network', value, extra) ??
    getStringFromRecords('chain', value, extra);
  const payTo =
    getStringFromRecords('payTo', value, extra) ??
    getString(value, 'to') ??
    getStringFromRecords('recipient', value, extra) ??
    getStringFromRecords('address', value, extra);
  const assetRaw =
    getStringFromRecords('asset', value, extra) ??
    getStringFromRecords('token', value, extra) ??
    getStringFromRecords('assetAddress', value, extra);
  const asset = assetRaw && assetRaw.length > 0 ? assetRaw : ZERO_ASSET;
  const amount = getIntegerStringFromRecords('amount', value, extra) ??
    getIntegerStringFromRecords('maxAmountRequired', value, extra) ??
    getIntegerStringFromRecords('maxAmount', value, extra) ??
    getIntegerStringFromRecords('price', value, extra);

  if (!scheme || !network || !payTo || !amount) return undefined;

  const normalized: Record<string, unknown> = {
    scheme,
    network,
    amount,
    payTo,
    asset
  };
  normalized.resource = getStringFromRecords('resource', value, extra) ?? ctx.requestUrl;

  const description = getStringFromRecords('description', value, extra);
  if (description) normalized.description = description;
  const mimeType = getStringFromRecords('mimeType', value, extra);
  if (mimeType) normalized.mimeType = mimeType;
  const maxTimeoutSeconds = value.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds)) {
    normalized.maxTimeoutSeconds = Math.trunc(maxTimeoutSeconds);
  }
  if (value.outputSchema !== undefined) normalized.outputSchema = value.outputSchema;
  const timeoutSeconds =
    typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds) && maxTimeoutSeconds > 0
      ? Math.trunc(maxTimeoutSeconds)
      : typeof maxTimeoutSeconds === 'string'
        ? (() => {
            const parsed = Number(maxTimeoutSeconds);
            return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 300;
          })()
        : 300;
  const fallbackChallengeExpiry = String(Math.floor(Date.now() / 1000) + timeoutSeconds);
  const fallbackVerifyingContract =
    /^0x[0-9a-fA-F]{40}$/.test(payTo) ? payTo : ZERO_ADDRESS;

  const rail = getStringFromRecords('rail', value, extra) ?? 'x402-standard';
  const challengeNonce = getStringFromRecords('challengeNonce', value, extra) ?? ZERO_BYTES32;
  const challengeExpiry = getStringFromRecords('challengeExpiry', value, extra) ?? fallbackChallengeExpiry;
  const merchantPubKey = getStringFromRecords('merchantPubKey', value, extra) ?? ZERO_BYTES32;
  const verifyingContract = getStringFromRecords('verifyingContract', value, extra) ?? fallbackVerifyingContract;

  normalized.rail = rail;
  normalized.challengeNonce = challengeNonce;
  normalized.challengeExpiry = challengeExpiry;
  normalized.merchantPubKey = merchantPubKey;
  normalized.verifyingContract = verifyingContract;
  normalized.extra = {
    ...(extra ?? {}),
    rail,
    challengeNonce,
    challengeExpiry,
    merchantPubKey,
    verifyingContract
  };
  return normalized;
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

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    return getRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function extractRequirementCandidates(bodyRecord: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: unknown[] = [];
  if (Array.isArray(bodyRecord.accepts)) candidates.push(...bodyRecord.accepts);
  if (Array.isArray(bodyRecord.requirements)) candidates.push(...bodyRecord.requirements);
  if (candidates.length === 0) candidates.push(bodyRecord);
  return candidates
    .map((entry) => getRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function pickNormalizedRequirement(
  bodyRecord: Record<string, unknown>,
  normalizer: (entry: Record<string, unknown>) => Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return extractRequirementCandidates(bodyRecord)
    .map((entry) => normalizer(entry))
    .find((entry): entry is Record<string, unknown> => Boolean(entry));
}

async function parseResponseBodyRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await response.clone().text();
    return parseJsonRecord(text);
  } catch {
    return undefined;
  }
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
        const envelope = parsePaymentRequiredEnvelope(directHeader);
        const firstAccepted = getRecord(envelope.accepts[0]);
        if (!firstAccepted) return response;
        const normalized = normalizeRequirementLikeGeneric(firstAccepted, ctx);
        if (!normalized) return response;
        const normalizedEnvelope = {
          x402Version: 2 as const,
          accepts: [normalized],
          ...(typeof envelope.error === 'string' ? { error: envelope.error } : {})
        };
        return withHeader(response, encodeX402Header(normalizedEnvelope));
      }

      const bodyText = await response.text();
      const bodyRecord = parseJsonRecord(bodyText);
      if (!bodyRecord) return response;

      const normalized = pickNormalizedRequirement(bodyRecord, (entry) =>
        normalizeRequirementLikeGeneric(entry, ctx)
      );

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
    try {
      return {
        response: normalized,
        requirement: parsePaymentRequiredHeader(header)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('payment requirement missing shielded rail metadata')) {
        throw error;
      }
      const envelope = parsePaymentRequiredEnvelope(header);
      const firstAccepted = getRecord(envelope.accepts[0]);
      if (firstAccepted) {
        const normalizedFallback =
          normalizeRequirementLikeWithAdapters(firstAccepted, ctx, adapters) ??
          normalizeRequirementLikeGeneric(firstAccepted, ctx);
        if (normalizedFallback) {
          const repairedHeader = encodeX402Header({
            x402Version: 2 as const,
            accepts: [normalizedFallback],
            ...(typeof envelope.error === 'string' ? { error: envelope.error } : {})
          });
          return {
            response: withHeader(normalized, repairedHeader),
            requirement: parsePaymentRequiredHeader(repairedHeader)
          };
        }
      }
      throw error;
    }
  }

  const bodyRecord = await parseResponseBodyRecord(normalized);
  if (!bodyRecord) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }

  const normalizedRequirement = pickNormalizedRequirement(bodyRecord, (entry) =>
    normalizeRequirementLikeWithAdapters(entry, ctx, adapters)
  );

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
