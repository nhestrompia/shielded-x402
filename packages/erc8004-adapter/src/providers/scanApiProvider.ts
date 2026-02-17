import type {
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  CanonicalTrustSnapshot,
  Hex,
  ServiceProtocol
} from '@shielded-x402/shared-types';
import type { DirectoryProvider, ResolveAgentInput, SearchAgentsInput } from '../types.js';

interface ScanApiProviderConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function lowerHexOrUndefined(value: unknown): Hex | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return undefined;
  return value.toLowerCase() as Hex;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mapProtocol(value: string): ServiceProtocol | undefined {
  const lowered = value.toLowerCase();
  if (
    lowered === 'a2a' ||
    lowered === 'mcp' ||
    lowered === 'web' ||
    lowered === 'oasf' ||
    lowered === 'email' ||
    lowered === 'ens' ||
    lowered === 'did'
  ) {
    return lowered;
  }
  return undefined;
}

function serviceFromKey(
  protocolKey: string,
  value: unknown
): CanonicalServiceEndpoint | undefined {
  const protocol = mapProtocol(protocolKey);
  if (!protocol) return undefined;

  if (typeof value === 'string') {
    if (protocol === 'email' || protocol === 'ens' || protocol === 'did') {
      return { protocol, identifier: value, raw: { value } };
    }
    return { protocol, url: value, raw: { value } };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const url =
    toStringOrUndefined(record.endpoint) ??
    toStringOrUndefined(record.url) ??
    toStringOrUndefined(record.agent_url);
  const identifier =
    protocol === 'email' || protocol === 'ens' || protocol === 'did'
      ? toStringOrUndefined(record.identifier) ?? toStringOrUndefined(record.value)
      : undefined;

  const capabilitiesRaw = record.capabilities ?? record.skills ?? record.tools;
  const capabilities = Array.isArray(capabilitiesRaw)
    ? capabilitiesRaw.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const version = toStringOrUndefined(record.version);

  return {
    protocol,
    ...(url ? { url } : {}),
    ...(identifier ? { identifier } : {}),
    ...(version ? { version } : {}),
    ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
    raw: record
  };
}

function extractServices(record: Record<string, unknown>): CanonicalServiceEndpoint[] {
  const out: CanonicalServiceEndpoint[] = [];
  const services = record.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [key, value] of Object.entries(services as Record<string, unknown>)) {
      const mapped = serviceFromKey(key, value);
      if (mapped) out.push(mapped);
    }
  }

  const endpoints = record.endpoints;
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    for (const [key, value] of Object.entries(endpoints as Record<string, unknown>)) {
      const mapped = serviceFromKey(key, value);
      if (!mapped) continue;
      if (
        !out.some(
          (existing) =>
            existing.protocol === mapped.protocol &&
            (existing.url ?? existing.identifier ?? '') ===
              (mapped.url ?? mapped.identifier ?? '')
        )
      ) {
        out.push(mapped);
      }
    }
  }
  return out;
}

function extractTrust(
  agent: Record<string, unknown>,
  stats: Record<string, unknown> | undefined
): CanonicalTrustSnapshot | undefined {
  const score =
    toNumberOrUndefined(stats?.overall_score) ??
    toNumberOrUndefined(agent.total_score) ??
    toNumberOrUndefined(stats?.score);
  const healthStatus = toStringOrUndefined(agent.health_status) ?? toStringOrUndefined(stats?.health_status);
  const feedbackCount =
    toNumberOrUndefined(stats?.total_feedbacks) ?? toNumberOrUndefined(agent.total_feedbacks);
  const avgFeedbackScore =
    toNumberOrUndefined(stats?.average_feedback_score) ?? toNumberOrUndefined(agent.average_score);
  const lastActiveAt = toStringOrUndefined(stats?.last_active) ?? toStringOrUndefined(agent.updated_at);
  const parseStatusRaw =
    toStringOrUndefined((agent.parse_status as Record<string, unknown> | undefined)?.status) ??
    toStringOrUndefined((stats?.parse_status as Record<string, unknown> | undefined)?.status);

  const parseStatus =
    parseStatusRaw === 'success' || parseStatusRaw === 'warning' || parseStatusRaw === 'error'
      ? parseStatusRaw
      : undefined;
  const normalizedHealth =
    healthStatus === 'healthy' || healthStatus === 'degraded' || healthStatus === 'unknown'
      ? healthStatus
      : undefined;

  if (
    score === undefined &&
    normalizedHealth === undefined &&
    feedbackCount === undefined &&
    avgFeedbackScore === undefined &&
    lastActiveAt === undefined &&
    parseStatus === undefined
  ) {
    return undefined;
  }

  return {
    snapshotTimestamp: new Date().toISOString(),
    source: 'indexer',
    ...(score !== undefined ? { score } : {}),
    ...(normalizedHealth ? { healthStatus: normalizedHealth } : {}),
    ...(feedbackCount !== undefined ? { feedbackCount } : {}),
    ...(avgFeedbackScore !== undefined ? { avgFeedbackScore } : {}),
    ...(lastActiveAt ? { lastActiveAt } : {}),
    ...(parseStatus ? { parseStatus } : {}),
    raw: {
      agent,
      ...(stats ? { stats } : {})
    }
  };
}

function mapAgentRecord(
  chainId: number,
  tokenId: string,
  payload: Record<string, unknown>,
  statsPayload?: Record<string, unknown>
): CanonicalAgentProfile {
  const resolvedChainId = toNumberOrUndefined(payload.chain_id) ?? chainId;
  const resolvedTokenId = toStringOrUndefined(payload.token_id) ?? tokenId;
  const trust = extractTrust(payload, statsPayload);
  const registryAddress = lowerHexOrUndefined(payload.contract_address ?? payload.registry_address);
  const ownerAddress = lowerHexOrUndefined(payload.owner_address);
  const name = toStringOrUndefined(payload.name);
  const description = toStringOrUndefined(payload.description);
  const imageUrl = toStringOrUndefined(payload.image_url);

  return {
    chainId: resolvedChainId,
    tokenId: resolvedTokenId,
    ...(registryAddress ? { registryAddress } : {}),
    ...(ownerAddress ? { ownerAddress } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(typeof payload.x402_supported === 'boolean'
      ? { x402Supported: payload.x402_supported }
      : {}),
    services: extractServices(payload),
    ...(trust ? { trust } : {}),
    sourceMetadata: {
      onchainResolved: false,
      indexerResolved: true
    },
    raw: payload
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`scan api ${response.status} for ${url}: ${body}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function makeUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function createScanApiProvider(config: ScanApiProviderConfig = {}): DirectoryProvider {
  const baseUrl = config.baseUrl ?? 'https://www.8004scan.io';
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    name: 'scan-api',

    resolveAgent: async (input: ResolveAgentInput): Promise<CanonicalAgentProfile | null> => {
      const agent = await fetchJson(
        fetchImpl,
        makeUrl(baseUrl, `/api/v1/agents/${input.chainId}/${encodeURIComponent(input.tokenId)}`),
        timeoutMs
      );
      if (!agent) return null;
      const stats =
        (await fetchJson(
          fetchImpl,
          makeUrl(baseUrl, `/api/v1/stats/agents/${input.chainId}/${encodeURIComponent(input.tokenId)}`),
          timeoutMs
        )) ?? undefined;
      return mapAgentRecord(input.chainId, input.tokenId, agent, stats);
    },

    getTrust: async (input: ResolveAgentInput): Promise<CanonicalTrustSnapshot | null> => {
      const stats = await fetchJson(
        fetchImpl,
        makeUrl(baseUrl, `/api/v1/stats/agents/${input.chainId}/${encodeURIComponent(input.tokenId)}`),
        timeoutMs
      );
      if (!stats) return null;
      const trust = extractTrust({}, stats);
      return trust ?? null;
    },

    search: async (input: SearchAgentsInput): Promise<CanonicalAgentProfile[]> => {
      const payload = await fetchJson(
        fetchImpl,
        makeUrl(baseUrl, '/api/v1/agents', {
          sort_by: 'created_at',
          sort_order: 'desc',
          limit: input.limit ?? 20,
          offset: input.offset ?? 0,
          is_registered: true,
          is_testnet: input.isTestnet === true,
          chain_id: input.chainId,
          search: input.query
        }),
        timeoutMs
      );
      if (!payload) return [];
      const items = Array.isArray(payload.items) ? payload.items : [];
      const mapped = items
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => {
          const chainId = toNumberOrUndefined(entry.chain_id) ?? input.chainId ?? 0;
          const tokenId = toStringOrUndefined(entry.token_id) ?? '';
          return mapAgentRecord(chainId, tokenId, entry);
        })
        .filter((entry) => entry.tokenId !== '' && entry.chainId > 0);

      if (input.query && input.query.trim().length > 0) {
        const q = input.query.toLowerCase();
        return mapped.filter(
          (agent) =>
            (agent.name ?? '').toLowerCase().includes(q) ||
            (agent.description ?? '').toLowerCase().includes(q) ||
            agent.tokenId.includes(q)
        );
      }
      return mapped;
    }
  };
}
