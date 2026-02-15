import type { RelayerMerchantResult } from '@shielded-x402/shared-types';
import type { PayoutAdapter, PayoutRequest } from './types.js';

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function createNoopPayoutAdapter(): PayoutAdapter {
  return {
    payMerchant: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, mode: 'noop-payout' }),
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
      if (method !== 'GET' && method !== 'HEAD' && request.merchantRequest.body !== undefined) {
        init.body = request.merchantRequest.body;
      }

      const response = await fetchImpl(request.merchantRequest.url, init);
      const body = await response.text();

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body,
        payoutReference: `${request.settlementId}:${response.status}`
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
