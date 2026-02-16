import {
  X402_HEADERS,
  parsePaymentRequiredEnvelope,
  type RelayerMerchantResult
} from '@shielded-x402/shared-types';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia, type Chain } from 'viem/chains';
import type { PayoutAdapter, PayoutRequest } from './types.js';

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function createNoopPayoutAdapter(): PayoutAdapter {
  return {
    payMerchant: async () => ({
      status: 200,
      headers: {},
      bodyBase64: bytesToBase64(Buffer.from(JSON.stringify({ ok: true, mode: 'noop-payout' }))),
      payoutReference: 'noop'
    })
  };
}

export interface ForwardPayoutConfig {
  fetchImpl?: typeof fetch;
  staticHeaders?: Record<string, string>;
}

export function createForwardPayoutAdapter(config: ForwardPayoutConfig = {}): PayoutAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    payMerchant: async (request: PayoutRequest): Promise<RelayerMerchantResult> => {
      const method = request.merchantRequest.method.toUpperCase();
      const mergedHeaders: Record<string, string> = {
        ...(request.merchantRequest.headers ?? {}),
        ...(config.staticHeaders ?? {})
      };
      const init: RequestInit = {
        method,
        headers: mergedHeaders
      };
      if (
        method !== 'GET' &&
        method !== 'HEAD' &&
        request.merchantRequest.bodyBase64 !== undefined
      ) {
        init.body = Buffer.from(request.merchantRequest.bodyBase64, 'base64');
      }

      const response = await fetchImpl(request.merchantRequest.url, init);
      const body = bytesToBase64(new Uint8Array(await response.arrayBuffer()));

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        bodyBase64: body,
        payoutReference: `${request.settlementId}:${response.status}`
      };
    }
  };
}

type WrapFetchWithPayment = (
  baseFetch: typeof fetch,
  walletClient: ReturnType<typeof createWalletClient>
) => typeof fetch;

export interface X402PayoutConfig extends ForwardPayoutConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  chain?: 'base-sepolia' | 'sepolia';
  wrapFetchWithPayment?: WrapFetchWithPayment;
  providerAdapters?: X402ProviderAdapter[];
}

export interface X402ProviderAdapterContext {
  requestUrl: string;
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

function resolveChain(chain: X402PayoutConfig['chain']): Chain {
  switch (chain) {
    case 'sepolia':
      return sepolia;
    case 'base-sepolia':
    default:
      return baseSepolia;
  }
}

async function loadWrapFetchWithPayment(): Promise<WrapFetchWithPayment> {
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
  const module = (await dynamicImport('x402-fetch')) as {
    wrapFetchWithPayment?: WrapFetchWithPayment;
  };
  const wrap = module.wrapFetchWithPayment;
  if (typeof wrap !== 'function') {
    throw new Error('x402-fetch.wrapFetchWithPayment is unavailable');
  }
  return wrap;
}

function stripPaymentHeaders(headers: Record<string, string>): Record<string, string> {
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

const X402_NETWORK_TO_EIP155_CAIP: Record<string, string> = {
  'base-sepolia': 'eip155:84532',
  base: 'eip155:8453',
  'avalanche-fuji': 'eip155:43113',
  avalanche: 'eip155:43114',
  iotex: 'eip155:4689',
  sei: 'eip155:1329',
  'sei-testnet': 'eip155:1328',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  peaq: 'eip155:3338'
};

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

function remapPaymentHeaderNetworkToCaip(rawHeader: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rawHeader;
    }
    const payment = parsed as Record<string, unknown>;
    const network = typeof payment.network === 'string' ? payment.network.toLowerCase() : undefined;
    if (!network) return rawHeader;
    const mapped = X402_NETWORK_TO_EIP155_CAIP[network];
    if (!mapped || mapped === payment.network) return rawHeader;
    const rewritten = {
      ...payment,
      network: mapped
    };
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
  const extra = getRecord(raw.extra);

  const scheme = (getString(raw, 'scheme') ?? getString(extra ?? {}, 'scheme') ?? 'exact').toLowerCase();
  if (scheme !== 'exact') {
    return undefined;
  }

  const network = normalizeNetwork(
    getString(raw, 'network') ?? getString(extra ?? {}, 'network')
  );
  if (!network) return undefined;

  const payTo =
    getString(raw, 'payTo') ??
    getString(raw, 'to') ??
    getString(extra ?? {}, 'payTo');
  const asset =
    getString(raw, 'asset') ??
    getString(extra ?? {}, 'asset');
  const maxAmountRequired =
    getIntegerString(raw, 'maxAmountRequired') ??
    getIntegerString(raw, 'amount') ??
    getIntegerString(extra ?? {}, 'maxAmountRequired') ??
    getIntegerString(extra ?? {}, 'amount');

  if (!payTo || !asset || !maxAmountRequired) {
    return undefined;
  }

  const resource =
    getString(raw, 'resource') ??
    getString(extra ?? {}, 'resource') ??
    fallbackResource;
  const description =
    getString(raw, 'description') ??
    getString(extra ?? {}, 'description') ??
    'x402 payment';
  const mimeType =
    getString(raw, 'mimeType') ??
    getString(extra ?? {}, 'mimeType') ??
    'application/json';
  const maxTimeoutSeconds = parseTimeoutSeconds(
    raw.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds,
    300
  );
  const outputSchema = normalizeOutputSchema(raw.outputSchema ?? extra?.outputSchema);

  return {
    scheme: 'exact',
    network,
    maxAmountRequired,
    resource,
    description,
    mimeType,
    payTo,
    maxTimeoutSeconds,
    asset,
    ...(outputSchema ? { outputSchema } : {}),
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

function responseFromText(response: Response, bodyText: string): Response {
  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
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
  let parsedBody = (() => {
    if (bodyText.length === 0) return undefined;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      return getRecord(parsed);
    } catch {
      return undefined;
    }
  })();

  if (!parsedBody) {
    const paymentRequiredHeader = response.headers.get(X402_HEADERS.paymentRequired);
    if (paymentRequiredHeader) {
      try {
        const envelope = parsePaymentRequiredEnvelope(paymentRequiredHeader);
        parsedBody = {
          x402Version: envelope.x402Version,
          accepts: envelope.accepts,
          ...(typeof envelope.error === 'string' ? { error: envelope.error } : {})
        };
      } catch {
        // keep undefined; we will return the original body as-is
      }
    }
  }

  if (parsedBody && providerAdapter?.transformParsed402Body) {
    parsedBody = providerAdapter.transformParsed402Body(parsedBody, context);
  }

  if (!parsedBody) {
    return responseFromText(response, bodyText);
  }

  let normalized = normalizePaymentRequiredBody(parsedBody, fallbackResource);
  if (!normalized) {
    return responseFromText(response, bodyText);
  }
  if (providerAdapter?.transformNormalized402Body) {
    normalized = providerAdapter.transformNormalized402Body(normalized, context);
  }

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

function createAdaptiveX402BaseFetch(
  fetchImpl: typeof fetch,
  providerAdapters: X402ProviderAdapter[] | undefined
): typeof fetch {
  return async (input, init) => {
    const inputUrl = resolveInputUrl(input) ?? 'https://example.invalid';
    const context: X402ProviderAdapterContext = { requestUrl: inputUrl };
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
    return normalize402Response(response, inputUrl, providerAdapter, context);
  };
}

function isPayaiHost(requestUrl: string): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    return host === 'payai.network' || host.endsWith('.payai.network');
  } catch {
    return false;
  }
}

export function createPayaiX402ProviderAdapter(): X402ProviderAdapter {
  return {
    name: 'payai',
    matches: ({ requestUrl }) => isPayaiHost(requestUrl),
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
    transformOutgoingRequestHeaders: (headers) => {
      const next = new Headers(headers);
      const paymentSignature = next.get(X402_HEADERS.paymentSignature);
      const xPayment = next.get('x-payment') ?? next.get('X-PAYMENT');
      const signature = paymentSignature ?? xPayment;
      if (signature) {
        const rewrittenSignature = remapPaymentHeaderNetworkToCaip(signature);
        next.set(X402_HEADERS.paymentSignature, rewrittenSignature);
        next.set('X-PAYMENT', rewrittenSignature);
      }
      return next;
    }
  };
}

export function createX402PayoutAdapter(config: X402PayoutConfig): PayoutAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;
  const chain = resolveChain(config.chain);
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl)
  });
  let paidFetchPromise: Promise<typeof fetch> | undefined;

  const getPaidFetch = async (): Promise<typeof fetch> => {
    if (!paidFetchPromise) {
      paidFetchPromise = (async () => {
        const wrap = config.wrapFetchWithPayment ?? (await loadWrapFetchWithPayment());
        return wrap(createAdaptiveX402BaseFetch(fetchImpl, config.providerAdapters), walletClient);
      })();
    }
    return paidFetchPromise;
  };

  return {
    payMerchant: async (request: PayoutRequest): Promise<RelayerMerchantResult> => {
      const paidFetch = await getPaidFetch();
      const method = request.merchantRequest.method.toUpperCase();
      const mergedHeaders = stripPaymentHeaders({
        ...(request.merchantRequest.headers ?? {}),
        ...(config.staticHeaders ?? {})
      });
      const init: RequestInit = {
        method,
        headers: mergedHeaders
      };
      if (
        method !== 'GET' &&
        method !== 'HEAD' &&
        request.merchantRequest.bodyBase64 !== undefined
      ) {
        init.body = Buffer.from(request.merchantRequest.bodyBase64, 'base64');
      }

      const response = await paidFetch(request.merchantRequest.url, init);
      const body = bytesToBase64(new Uint8Array(await response.arrayBuffer()));

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        bodyBase64: body,
        payoutReference: `${request.settlementId}:${response.status}:x402`
      };
    }
  };
}

export interface WebhookPayoutConfig {
  fetchImpl?: typeof fetch;
  webhookUrl: string;
  apiKey?: string;
}

export function createWebhookPayoutAdapter(config: WebhookPayoutConfig): PayoutAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    payMerchant: async (request: PayoutRequest): Promise<RelayerMerchantResult> => {
      const response = await fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`webhook payout failed: ${response.status} ${text}`);
      }

      return (await response.json()) as RelayerMerchantResult;
    }
  };
}
