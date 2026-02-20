import {
  headersToRecord,
  type RelayerMerchantResult
} from '@shielded-x402/shared-types';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia, type Chain } from 'viem/chains';
import type { PayoutAdapter, PayoutRequest } from './types.js';
import {
  createAdaptiveX402BaseFetch,
  createPayaiX402ProviderAdapter,
  stripPaymentHeaders,
  type X402ProviderAdapter
} from './payoutX402.js';
export {
  createPayaiX402ProviderAdapter,
  type HostedX402ProviderAdapterConfig,
  type X402ProviderAdapter,
  type X402ProviderAdapterContext
} from './payoutX402.js';

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function buildMerchantFetchInit(
  merchantRequest: PayoutRequest['merchantRequest'],
  extraHeaders?: Record<string, string>,
  transformHeaders?: (headers: Record<string, string>) => Record<string, string>
): RequestInit {
  const method = merchantRequest.method.toUpperCase();
  const mergedHeaders = transformHeaders
    ? transformHeaders({
        ...(merchantRequest.headers ?? {}),
        ...(extraHeaders ?? {})
      })
    : {
        ...(merchantRequest.headers ?? {}),
        ...(extraHeaders ?? {})
      };

  const init: RequestInit = {
    method,
    headers: mergedHeaders
  };
  if (method !== 'GET' && method !== 'HEAD' && merchantRequest.bodyBase64 !== undefined) {
    init.body = Buffer.from(merchantRequest.bodyBase64, 'base64');
  }
  return init;
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
      const init = buildMerchantFetchInit(request.merchantRequest, config.staticHeaders);
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
  // Use a runtime dynamic import so this module can run in environments where `x402-fetch`
  // is optional and only needed for x402 payout mode.
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
      const init = buildMerchantFetchInit(
        request.merchantRequest,
        config.staticHeaders,
        stripPaymentHeaders
      );
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
