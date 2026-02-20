import {
  X402_HEADERS,
  getIntegerString,
  getIntegerStringFromRecords,
  getRecord,
  getString,
  getStringFromRecords,
  parsePaymentRequiredEnvelope
} from '@shielded-x402/shared-types';

export interface X402ProviderAdapterContext {
  requestUrl: string;
  cachedAcceptRequirement?: Record<string, unknown>;
}

export interface X402ProviderAdapter {
  name?: string;
  matches?: (context: X402ProviderAdapterContext) => boolean;
  transformOutgoingRequestHeaders?: (
    headers: Headers,
    context: X402ProviderAdapterContext
  ) => HeadersInit;
  transformParsed402Body?: (
    body: Record<string, unknown>,
    context: X402ProviderAdapterContext
  ) => Record<string, unknown>;
  transformNormalized402Body?: (
    body: Record<string, unknown>,
    context: X402ProviderAdapterContext
  ) => Record<string, unknown>;
}

export function stripPaymentHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'payment-signature' ||
      lower === 'payment-required' ||
      lower === 'payment-response' ||
      lower === 'x-payment' ||
      lower === 'x-payment-response'
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

const SUPPORTED_X402_NETWORKS = new Set([
  'base-sepolia',
  'base',
  'avalanche-fuji',
  'avalanche',
  'iotex',
  'solana-devnet',
  'solana',
  'sei',
  'sei-testnet',
  'polygon',
  'polygon-amoy',
  'peaq'
]);

const EIP155_CHAIN_ID_TO_X402_NETWORK: Record<string, string> = {
  '84532': 'base-sepolia',
  '8453': 'base',
  '43113': 'avalanche-fuji',
  '43114': 'avalanche',
  '4689': 'iotex',
  '1329': 'sei',
  '1328': 'sei-testnet',
  '137': 'polygon',
  '80002': 'polygon-amoy',
  '3338': 'peaq'
};

const X402_NETWORK_TO_EIP155_CAIP: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(EIP155_CHAIN_ID_TO_X402_NETWORK).map(([chainId, network]) => [
      network,
      `eip155:${chainId}`
    ])
  )
) as Record<string, string>;

function normalizeNetwork(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (SUPPORTED_X402_NETWORKS.has(lowered)) {
    return lowered;
  }
  if (lowered.startsWith('eip155:')) {
    const chainId = lowered.slice('eip155:'.length);
    return EIP155_CHAIN_ID_TO_X402_NETWORK[chainId];
  }
  if (/^\d+$/.test(lowered)) {
    return EIP155_CHAIN_ID_TO_X402_NETWORK[lowered];
  }
  return undefined;
}

function parseTimeoutSeconds(
  raw: unknown,
  fallbackSeconds: number
): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return fallbackSeconds;
}

function normalizeOutputSchema(raw: unknown): Record<string, unknown> | undefined {
  const objectValue = getRecord(raw);
  if (objectValue) return objectValue;

  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return getRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getAcceptExtra(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return getRecord(raw.extra);
}

function resolveAcceptCoreFields(
  raw: Record<string, unknown>,
  extra: Record<string, unknown> | undefined
): { network: string; payTo: string; asset: string; maxAmountRequired: string } | undefined {
  const network = normalizeNetwork(getStringFromRecords('network', raw, extra));
  if (!network) return undefined;

  const payTo = getStringFromRecords('payTo', raw, extra) ?? getString(raw, 'to');
  const asset = getStringFromRecords('asset', raw, extra);
  const maxAmountRequired = getIntegerStringFromRecords(
    'maxAmountRequired',
    raw,
    extra
  ) ?? getIntegerStringFromRecords('amount', raw, extra);

  if (!payTo || !asset || !maxAmountRequired) return undefined;
  return { network, payTo, asset, maxAmountRequired };
}

function resolveAcceptMetadataFields(
  raw: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
  fallbackResource: string
): {
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  outputSchema?: Record<string, unknown>;
} {
  const resource = getStringFromRecords('resource', raw, extra) ?? fallbackResource;
  const description = getStringFromRecords('description', raw, extra) ?? 'x402 payment';
  const mimeType = getStringFromRecords('mimeType', raw, extra) ?? 'application/json';
  const maxTimeoutSeconds = parseTimeoutSeconds(raw.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds, 300);
  const outputSchema = normalizeOutputSchema(raw.outputSchema ?? extra?.outputSchema);
  return {
    resource,
    description,
    mimeType,
    maxTimeoutSeconds,
    ...(outputSchema ? { outputSchema } : {})
  };
}

function toEip155CaipNetwork(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered.startsWith('eip155:')) return lowered;
  const normalized = normalizeNetwork(lowered);
  if (!normalized) return undefined;
  return X402_NETWORK_TO_EIP155_CAIP[normalized];
}

function buildPayaiAcceptedRequirement(
  source: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const network = toEip155CaipNetwork(getString(source, 'network'));
  const amount =
    getIntegerString(source, 'amount') ??
    getIntegerString(source, 'maxAmountRequired');
  const payTo = getString(source, 'payTo');
  const asset = getString(source, 'asset');
  if (!network || !amount || !payTo || !asset) return undefined;

  const out: Record<string, unknown> = {
    scheme: 'exact',
    network,
    amount,
    payTo,
    asset
  };
  const maxTimeoutSeconds = source.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds)) {
    out.maxTimeoutSeconds = Math.trunc(maxTimeoutSeconds);
  }
  const resource = getString(source, 'resource');
  if (resource) out.resource = resource;
  const description = getString(source, 'description');
  if (description) out.description = description;
  const mimeType = getString(source, 'mimeType');
  if (mimeType) out.mimeType = mimeType;
  const outputSchema = getRecord(source.outputSchema);
  if (outputSchema) out.outputSchema = outputSchema;
  return out;
}

function rewritePaymentSignatureForPayai(
  rawHeader: string,
  cachedAcceptRequirement: Record<string, unknown> | undefined
): string {
  try {
    const parsed = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rawHeader;
    }
    const payment = parsed as Record<string, unknown>;
    const rewritten: Record<string, unknown> = { ...payment };
    const caipNetwork = toEip155CaipNetwork(getString(payment, 'network'));
    if (caipNetwork) {
      rewritten.network = caipNetwork;
    }

    const authorization = getRecord(getRecord(payment.payload)?.authorization);
    const acceptedFromPayload = buildPayaiAcceptedRequirement(getRecord(payment.accepted));
    const acceptedFromCache = buildPayaiAcceptedRequirement(cachedAcceptRequirement);
    const accepted: Record<string, unknown> = {
      ...(acceptedFromCache ?? {}),
      ...(acceptedFromPayload ?? {})
    };
    if (!accepted.network && caipNetwork) accepted.network = caipNetwork;
    if (!accepted.amount) {
      const value = getIntegerString(authorization ?? {}, 'value');
      if (value) accepted.amount = value;
    }
    if (!accepted.payTo) {
      const to = getString(authorization ?? {}, 'to');
      if (to) accepted.payTo = to;
    }
    if (
      typeof accepted.network === 'string' &&
      typeof accepted.amount === 'string' &&
      typeof accepted.payTo === 'string' &&
      typeof accepted.asset === 'string'
    ) {
      accepted.scheme = 'exact';
      rewritten.accepted = accepted;
    }

    if (rewritten.x402Version === undefined) {
      rewritten.x402Version = 2;
    }
    return Buffer.from(JSON.stringify(rewritten), 'utf8').toString('base64');
  } catch {
    return rawHeader;
  }
}

function findMatchingProviderAdapter(
  adapters: X402ProviderAdapter[] | undefined,
  context: X402ProviderAdapterContext
): X402ProviderAdapter | undefined {
  if (!adapters || adapters.length === 0) return undefined;
  for (const adapter of adapters) {
    if (!adapter.matches || adapter.matches(context)) {
      return adapter;
    }
  }
  return undefined;
}

function normalizeAcceptRequirement(
  rawAccept: unknown,
  fallbackResource: string
): Record<string, unknown> | undefined {
  const raw = getRecord(rawAccept);
  if (!raw) return undefined;
  const extra = getAcceptExtra(raw);

  const scheme = (getStringFromRecords('scheme', raw, extra) ?? 'exact').toLowerCase();
  if (scheme !== 'exact') {
    return undefined;
  }

  const core = resolveAcceptCoreFields(raw, extra);
  if (!core) return undefined;
  const metadata = resolveAcceptMetadataFields(raw, extra, fallbackResource);

  return {
    scheme: 'exact',
    network: core.network,
    maxAmountRequired: core.maxAmountRequired,
    resource: metadata.resource,
    description: metadata.description,
    mimeType: metadata.mimeType,
    payTo: core.payTo,
    maxTimeoutSeconds: metadata.maxTimeoutSeconds,
    asset: core.asset,
    ...(metadata.outputSchema ? { outputSchema: metadata.outputSchema } : {}),
    ...(extra ? { extra } : {})
  };
}

function normalizePaymentRequiredBody(
  rawBody: Record<string, unknown>,
  fallbackResource: string
): Record<string, unknown> | undefined {
  const rawAccepts = Array.isArray(rawBody.accepts) ? rawBody.accepts : [];
  const accepts = rawAccepts
    .map((accept) => normalizeAcceptRequirement(accept, fallbackResource))
    .filter((accept): accept is Record<string, unknown> => Boolean(accept));

  if (accepts.length === 0) {
    return undefined;
  }

  const x402Version =
    typeof rawBody.x402Version === 'number' && Number.isFinite(rawBody.x402Version)
      ? rawBody.x402Version
      : 1;

  return {
    x402Version,
    accepts,
    ...(typeof rawBody.error === 'string' ? { error: rawBody.error } : {})
  };
}

function parsePaymentRequiredBodyFromRaw(
  bodyText: string,
  paymentRequiredHeader: string | null
): Record<string, unknown> | undefined {
  const parsedBody = (() => {
    if (bodyText.length === 0) return undefined;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      return getRecord(parsed);
    } catch {
      return undefined;
    }
  })();
  if (parsedBody) return parsedBody;

  if (!paymentRequiredHeader) return undefined;
  try {
    const envelope = parsePaymentRequiredEnvelope(paymentRequiredHeader);
    return {
      x402Version: envelope.x402Version,
      accepts: envelope.accepts,
      ...(typeof envelope.error === 'string' ? { error: envelope.error } : {})
    };
  } catch {
    return undefined;
  }
}

function responseFromText(response: Response, bodyText: string): Response {
  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

function toJsonResponseLike(response: Response, payload: Record<string, unknown>): Response {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function applyParsed402ProviderTransform(
  parsedBody: Record<string, unknown> | undefined,
  providerAdapter: X402ProviderAdapter | undefined,
  context: X402ProviderAdapterContext
): Record<string, unknown> | undefined {
  if (!parsedBody || !providerAdapter?.transformParsed402Body) {
    return parsedBody;
  }
  return providerAdapter.transformParsed402Body(parsedBody, context);
}

function applyNormalized402ProviderTransform(
  normalizedBody: Record<string, unknown>,
  providerAdapter: X402ProviderAdapter | undefined,
  context: X402ProviderAdapterContext
): Record<string, unknown> {
  if (!providerAdapter?.transformNormalized402Body) {
    return normalizedBody;
  }
  return providerAdapter.transformNormalized402Body(normalizedBody, context);
}

async function normalize402Response(
  response: Response,
  fallbackResource: string,
  providerAdapter: X402ProviderAdapter | undefined,
  context: X402ProviderAdapterContext
): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }

  const bodyText = await response.text();
  let parsedBody = parsePaymentRequiredBodyFromRaw(
    bodyText,
    response.headers.get(X402_HEADERS.paymentRequired)
  );
  parsedBody = applyParsed402ProviderTransform(parsedBody, providerAdapter, context);

  if (!parsedBody) {
    return responseFromText(response, bodyText);
  }

  let normalized = normalizePaymentRequiredBody(parsedBody, fallbackResource);
  if (!normalized) {
    return responseFromText(response, bodyText);
  }
  normalized = applyNormalized402ProviderTransform(normalized, providerAdapter, context);
  return toJsonResponseLike(response, normalized);
}

function resolveInputUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input && 'url' in input) {
    const value = (input as { url?: unknown }).url;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function withPaymentHeaderAliases(headers: Headers): Headers {
  const xPayment = headers.get('x-payment');
  const paymentSignature = headers.get(X402_HEADERS.paymentSignature);
  if (xPayment && !paymentSignature) {
    headers.set(X402_HEADERS.paymentSignature, xPayment);
  }
  if (!xPayment && paymentSignature) {
    headers.set('X-PAYMENT', paymentSignature);
  }
  return headers;
}

async function updateAcceptRequirementCacheFrom402Response(
  response: Response,
  inputUrl: string,
  cache: Map<string, Record<string, unknown>>
): Promise<void> {
  if (response.status !== 402) return;
  try {
    const body = (await response.clone().json()) as unknown;
    const bodyRecord = getRecord(body);
    const accepts = bodyRecord && Array.isArray(bodyRecord.accepts) ? bodyRecord.accepts : [];
    const firstAccept = accepts.length > 0 ? getRecord(accepts[0]) : undefined;
    if (firstAccept) {
      cache.set(inputUrl, firstAccept);
    }
  } catch {
    // ignore cache refresh errors; response normalization still succeeded
  }
}

export function createAdaptiveX402BaseFetch(
  fetchImpl: typeof fetch,
  providerAdapters: X402ProviderAdapter[] | undefined
): typeof fetch {
  const acceptedRequirementCache = new Map<string, Record<string, unknown>>();

  return async (input, init) => {
    const inputUrl = resolveInputUrl(input) ?? 'https://example.invalid';
    const cachedAcceptRequirement = acceptedRequirementCache.get(inputUrl);
    const context: X402ProviderAdapterContext = cachedAcceptRequirement
      ? {
          requestUrl: inputUrl,
          cachedAcceptRequirement
        }
      : {
          requestUrl: inputUrl
        };
    const providerAdapter = findMatchingProviderAdapter(providerAdapters, context);
    let nextHeaders = withPaymentHeaderAliases(new Headers(init?.headers));
    if (providerAdapter?.transformOutgoingRequestHeaders) {
      nextHeaders = withPaymentHeaderAliases(
        new Headers(providerAdapter.transformOutgoingRequestHeaders(nextHeaders, context))
      );
    }
    const nextInit: RequestInit = {
      ...(init ?? {}),
      headers: nextHeaders
    };
    const response = await fetchImpl(input, nextInit);
    const normalizedResponse = await normalize402Response(response, inputUrl, providerAdapter, context);
    await updateAcceptRequirementCacheFrom402Response(
      normalizedResponse,
      inputUrl,
      acceptedRequirementCache
    );
    return normalizedResponse;
  };
}

function isProviderHost(requestUrl: string, domains: string[]): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export interface HostedX402ProviderAdapterConfig {
  domains?: string[];
}

export function createPayaiX402ProviderAdapter(
  config: HostedX402ProviderAdapterConfig = {}
): X402ProviderAdapter {
  const domains = (config.domains ?? ['payai.network']).map((value) =>
    value.toLowerCase()
  );
  return {
    name: 'payai',
    matches: ({ requestUrl }) => isProviderHost(requestUrl, domains),
    transformParsed402Body: (body) => {
      if (Array.isArray(body.accepts)) {
        return body;
      }
      const requirements = Array.isArray(body.requirements) ? body.requirements : [];
      if (requirements.length === 0) {
        return body;
      }
      return {
        ...body,
        x402Version:
          typeof body.x402Version === 'number' && Number.isFinite(body.x402Version)
            ? body.x402Version
            : 2,
        accepts: requirements
      };
    },
    transformOutgoingRequestHeaders: (headers, context) => {
      const next = new Headers(headers);
      const paymentSignature = next.get(X402_HEADERS.paymentSignature);
      const xPayment = next.get('x-payment') ?? next.get('X-PAYMENT');
      const signature = paymentSignature ?? xPayment;
      if (signature) {
        const rewrittenSignature = rewritePaymentSignatureForPayai(
          signature,
          context.cachedAcceptRequirement
        );
        next.set(X402_HEADERS.paymentSignature, rewrittenSignature);
        next.set('X-PAYMENT', rewrittenSignature);
      }
      return next;
    }
  };
}
