import type { Erc8004DirectoryClient } from '@shielded-x402/erc8004-adapter';
import type {
  AgentPaymentErrorCode,
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  CounterpartySelectionResult
} from '@shielded-x402/shared-types';
import { createShieldedFetch, type CreateShieldedFetchConfig, type ShieldedFetch } from './shieldedFetch.js';
import {
  selectCounterpartyEndpoint,
  type CounterpartyPolicyConfig
} from './counterpartyPolicy.js';

export type AgentTarget =
  | { type: 'url'; url: string }
  | { type: 'erc8004'; chainId: number; tokenId: string; isTestnet?: boolean };

export interface A2AX402PaymentProfile {
  method: string;
  payee?: string;
  network?: string;
  endpoint?: string;
  facilitatorUrl?: string;
  raw: Record<string, unknown>;
}

export interface A2AResolvedCard {
  url: string;
  name?: string;
  description?: string;
  x402Payments: A2AX402PaymentProfile[];
  raw: Record<string, unknown>;
}

export class AgentPaymentError extends Error {
  constructor(
    public readonly code: AgentPaymentErrorCode,
    message: string,
    public readonly context: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface AgentPaymentFetchConfig extends CreateShieldedFetchConfig {
  directoryClient?: Erc8004DirectoryClient;
  targetPolicy?: CounterpartyPolicyConfig;
  onA2ACardResolved?: (args: {
    target: Extract<AgentTarget, { type: 'erc8004' }>;
    profile: CanonicalAgentProfile;
    selectedEndpoint: CanonicalServiceEndpoint;
    card: A2AResolvedCard;
  }) => Promise<void> | void;
  resolveA2AInvokeTarget?: (args: {
    target: Extract<AgentTarget, { type: 'erc8004' }>;
    profile: CanonicalAgentProfile;
    selectedEndpoint: CanonicalServiceEndpoint;
    card: A2AResolvedCard;
  }) => Promise<string | undefined> | string | undefined;
}

export type AgentPaymentFetch = (target: AgentTarget, init?: RequestInit) => Promise<Response>;

function endpointFromSelection(selection: CounterpartySelectionResult): string | undefined {
  return selection.selected?.endpoint.url;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractX402Payments(card: Record<string, unknown>): A2AX402PaymentProfile[] {
  const paymentsRaw = card.payments;
  if (!Array.isArray(paymentsRaw)) return [];

  const out: A2AX402PaymentProfile[] = [];
  for (const paymentEntry of paymentsRaw) {
    const payment = toRecord(paymentEntry);
    if (!payment) continue;
    const method = toStringOrUndefined(payment.method);
    if (!method || method.toLowerCase() !== 'x402') continue;

    const extensions = toRecord(payment.extensions);
    const x402Extension = extensions ? toRecord(extensions.x402) : undefined;
    const payee = toStringOrUndefined(payment.payee);
    const network = toStringOrUndefined(payment.network);
    const endpoint = toStringOrUndefined(payment.endpoint);
    const facilitatorUrl = toStringOrUndefined(x402Extension?.facilitatorUrl);

    out.push({
      method,
      ...(payee ? { payee } : {}),
      ...(network ? { network } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(facilitatorUrl ? { facilitatorUrl } : {}),
      raw: payment
    });
  }
  return out;
}

async function resolveA2ACard(
  target: Extract<AgentTarget, { type: 'erc8004' }>,
  profile: CanonicalAgentProfile,
  selectedEndpoint: CanonicalServiceEndpoint,
  selectedUrl: string,
  config: AgentPaymentFetchConfig
): Promise<{ finalUrl: string; card?: A2AResolvedCard; diagnostics?: string }> {
  if (selectedEndpoint.protocol !== 'a2a') {
    return { finalUrl: selectedUrl };
  }

  const baseFetch = config.fetchImpl ?? fetch;
  let payload: unknown;
  try {
    const response = await baseFetch(selectedUrl, {
      method: 'GET',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) {
      return {
        finalUrl: selectedUrl,
        diagnostics: `a2a-card-fetch-status=${response.status}`
      };
    }
    payload = await response.json().catch(() => undefined);
  } catch (error) {
    return {
      finalUrl: selectedUrl,
      diagnostics: `a2a-card-fetch-error=${error instanceof Error ? error.message : String(error)}`
    };
  }

  const cardRecord = toRecord(payload);
  if (!cardRecord) {
    return {
      finalUrl: selectedUrl,
      diagnostics: 'a2a-card-parse=invalid-json-shape'
    };
  }

  const card: A2AResolvedCard = {
    url: selectedUrl,
    x402Payments: extractX402Payments(cardRecord),
    raw: cardRecord
  };
  const name = toStringOrUndefined(cardRecord.name);
  const description = toStringOrUndefined(cardRecord.description);
  if (name) {
    card.name = name;
  }
  if (description) {
    card.description = description;
  }

  if (config.onA2ACardResolved) {
    await config.onA2ACardResolved({
      target,
      profile,
      selectedEndpoint,
      card
    });
  }

  const overriddenUrl = config.resolveA2AInvokeTarget
    ? await config.resolveA2AInvokeTarget({
        target,
        profile,
        selectedEndpoint,
        card
      })
    : undefined;

  return {
    finalUrl: overriddenUrl ?? selectedUrl,
    card
  };
}

async function resolveTargetUrl(
  target: AgentTarget,
  config: AgentPaymentFetchConfig
): Promise<{ url: string; context: Record<string, unknown> }> {
  if (target.type === 'url') {
    return { url: target.url, context: { targetType: 'url' } };
  }

  if (!config.directoryClient) {
    throw new AgentPaymentError(
      'E_DIRECTORY_UNAVAILABLE',
      'directoryClient is required for erc8004 targets',
      {
        target
      }
    );
  }

  let profile;
  try {
    profile = await config.directoryClient.resolveAgent({
      chainId: target.chainId,
      tokenId: target.tokenId,
      ...(target.isTestnet !== undefined ? { isTestnet: target.isTestnet } : {})
    });
  } catch (error) {
    throw new AgentPaymentError(
      'E_DIRECTORY_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { target }
    );
  }
  if (!profile) {
    throw new AgentPaymentError('E_AGENT_NOT_FOUND', 'agent not found in directory', { target });
  }

  const selection = selectCounterpartyEndpoint(profile, config.targetPolicy);
  const selectedUrl = endpointFromSelection(selection);
  if (!selectedUrl) {
    throw new AgentPaymentError(
      'E_NO_COMPATIBLE_ENDPOINT',
      'no compatible endpoint found for target agent',
      {
        target,
        selection
      }
    );
  }

  const selectedEndpoint = selection.selected?.endpoint;
  const a2aResolution =
    selectedEndpoint && target.type === 'erc8004'
      ? await resolveA2ACard(target, profile, selectedEndpoint, selectedUrl, config)
      : { finalUrl: selectedUrl };

  return {
    url: a2aResolution.finalUrl,
    context: {
      targetType: 'erc8004',
      selection,
      profile,
      ...(a2aResolution.card
        ? {
            a2aCard: {
              url: a2aResolution.card.url,
              name: a2aResolution.card.name,
              x402Payments: a2aResolution.card.x402Payments
            }
          }
        : {}),
      ...(a2aResolution.diagnostics ? { a2aDiagnostics: a2aResolution.diagnostics } : {})
    }
  };
}

export function createAgentPaymentFetch(config: AgentPaymentFetchConfig): AgentPaymentFetch {
  const shieldedFetchConfig: CreateShieldedFetchConfig = {
    sdk: config.sdk,
    resolveContext: config.resolveContext,
    ...(config.onUnsupportedRail ? { onUnsupportedRail: config.onUnsupportedRail } : {}),
    ...(config.prefetchRequirement ? { prefetchRequirement: config.prefetchRequirement } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.relayerEndpoint ? { relayerEndpoint: config.relayerEndpoint } : {}),
    ...(config.relayerPath ? { relayerPath: config.relayerPath } : {}),
    ...(config.challengeUrlResolver ? { challengeUrlResolver: config.challengeUrlResolver } : {}),
    ...(config.onRelayerSettlement ? { onRelayerSettlement: config.onRelayerSettlement } : {}),
    ...(config.requirementAdapters ? { requirementAdapters: config.requirementAdapters } : {})
  };

  const shieldedFetch: ShieldedFetch = createShieldedFetch(shieldedFetchConfig);

  return async (target: AgentTarget, init?: RequestInit): Promise<Response> => {
    let resolved: { url: string; context: Record<string, unknown> };
    try {
      resolved = await resolveTargetUrl(target, config);
    } catch (error) {
      if (error instanceof AgentPaymentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentPaymentError(
        'E_PAYMENT_EXECUTION_FAILED',
        message,
        {
          target,
          targetType: target.type
        }
      );
    }
    try {
      return await shieldedFetch(resolved.url, init);
    } catch (error) {
      if (error instanceof AgentPaymentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('requirement adapter')) {
        throw new AgentPaymentError('E_402_NORMALIZATION_FAILED', message, {
          target,
          ...resolved.context
        });
      }
      throw new AgentPaymentError(
        'E_PAYMENT_EXECUTION_FAILED',
        message,
        {
          target,
          ...resolved.context
        }
      );
    }
  };
}
