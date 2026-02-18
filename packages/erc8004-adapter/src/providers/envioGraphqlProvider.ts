import type {
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  CanonicalTrustSnapshot,
  Hex
} from '@shielded-x402/shared-types';
import type { DirectoryProvider, ResolveAgentInput, SearchAgentsInput } from '../types.js';

interface EnvioGraphqlProviderConfig {
  endpointUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface AgentIndexRow {
  chainId: string | number;
  tokenId: string | number;
  owner?: string | null;
  agentWallet?: string | null;
  tokenURI?: string | null;
  name?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  active?: boolean | null;
  x402Supported?: boolean | null;
  supportedTrust?: string | null;
  a2aEndpoint?: string | null;
  mcpEndpoint?: string | null;
  webEndpoint?: string | null;
  oasfEndpoint?: string | null;
  didIdentifier?: string | null;
  ensIdentifier?: string | null;
  emailIdentifier?: string | null;
  registrationsJson?: string | null;
  feedbackCount?: string | number | null;
  feedbackScoreSum?: string | number | null;
  feedbackRevokedCount?: string | number | null;
  validationCount?: string | number | null;
  successfulValidationCount?: string | number | null;
  lastUpdatedBlock?: string | number | null;
  updatedAt?: string | number | null;
}

const TABLE_FIELD_CANDIDATES = [
  'agentIndexProfiles',
  'agent_index_profiles',
  'AgentIndexProfile',
  'AgentIndexProfiles'
] as const;

const RESOLVE_QUERY_TEMPLATE = `
query ResolveAgent($chainId: BigInt!, $tokenId: BigInt!) {
  rows: __TABLE_FIELD__(where: { chainId: { _eq: $chainId }, tokenId: { _eq: $tokenId } }, limit: 1) {
    chainId
    tokenId
    owner
    agentWallet
    tokenURI
    name
    description
    imageUrl
    active
    x402Supported
    supportedTrust
    a2aEndpoint
    mcpEndpoint
    webEndpoint
    oasfEndpoint
    didIdentifier
    ensIdentifier
    emailIdentifier
    registrationsJson
    feedbackCount
    feedbackScoreSum
    feedbackRevokedCount
    validationCount
    successfulValidationCount
    lastUpdatedBlock
    updatedAt
  }
}
`;

const SEARCH_QUERY_TEMPLATE = `
query SearchAgents($limit: Int!, $offset: Int!, $chainId: BigInt) {
  rows: __TABLE_FIELD__(
    limit: $limit,
    offset: $offset,
    order_by: [{ updatedAt: desc }],
    where: { chainId: { _eq: $chainId } }
  ) {
    chainId
    tokenId
    owner
    agentWallet
    tokenURI
    name
    description
    imageUrl
    active
    x402Supported
    supportedTrust
    a2aEndpoint
    mcpEndpoint
    webEndpoint
    oasfEndpoint
    didIdentifier
    ensIdentifier
    emailIdentifier
    registrationsJson
    feedbackCount
    feedbackScoreSum
    feedbackRevokedCount
    validationCount
    successfulValidationCount
    lastUpdatedBlock
    updatedAt
  }
}
`;

const SEARCH_QUERY_ALL_CHAINS_TEMPLATE = `
query SearchAgentsAllChains($limit: Int!, $offset: Int!) {
  rows: __TABLE_FIELD__(
    limit: $limit,
    offset: $offset,
    order_by: [{ updatedAt: desc }]
  ) {
    chainId
    tokenId
    owner
    agentWallet
    tokenURI
    name
    description
    imageUrl
    active
    x402Supported
    supportedTrust
    a2aEndpoint
    mcpEndpoint
    webEndpoint
    oasfEndpoint
    didIdentifier
    ensIdentifier
    emailIdentifier
    registrationsJson
    feedbackCount
    feedbackScoreSum
    feedbackRevokedCount
    validationCount
    successfulValidationCount
    lastUpdatedBlock
    updatedAt
  }
}
`;

interface GraphqlRowsPayload {
  data?: {
    rows?: AgentIndexRow[];
  };
  errors?: Array<{ message?: string }>;
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

function lowerHexOrUndefined(value: unknown): Hex | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return undefined;
  return value.toLowerCase() as Hex;
}

function buildServices(row: AgentIndexRow): CanonicalServiceEndpoint[] {
  const services: CanonicalServiceEndpoint[] = [];
  const pushUrl = (protocol: CanonicalServiceEndpoint['protocol'], value: string | null | undefined): void => {
    const url = toStringOrUndefined(value);
    if (!url) return;
    services.push({ protocol, url, raw: { source: 'envio-indexer' } });
  };
  const pushId = (protocol: CanonicalServiceEndpoint['protocol'], value: string | null | undefined): void => {
    const identifier = toStringOrUndefined(value);
    if (!identifier) return;
    services.push({ protocol, identifier, raw: { source: 'envio-indexer' } });
  };

  pushUrl('a2a', row.a2aEndpoint);
  pushUrl('mcp', row.mcpEndpoint);
  pushUrl('web', row.webEndpoint);
  pushUrl('oasf', row.oasfEndpoint);
  pushId('did', row.didIdentifier);
  pushId('ens', row.ensIdentifier);
  pushId('email', row.emailIdentifier);

  return services;
}

function buildTrust(row: AgentIndexRow): CanonicalTrustSnapshot | undefined {
  const feedbackCount = toNumberOrUndefined(row.feedbackCount);
  const feedbackScoreSum = toNumberOrUndefined(row.feedbackScoreSum);
  const validationCount = toNumberOrUndefined(row.validationCount);
  const successfulValidationCount = toNumberOrUndefined(row.successfulValidationCount);
  const avgFeedbackScore =
    feedbackCount && feedbackCount > 0 && feedbackScoreSum !== undefined
      ? feedbackScoreSum / feedbackCount
      : undefined;
  const validationRatio =
    validationCount && validationCount > 0 && successfulValidationCount !== undefined
      ? successfulValidationCount / validationCount
      : undefined;
  const score =
    avgFeedbackScore !== undefined && validationRatio !== undefined
      ? avgFeedbackScore * 0.7 + validationRatio * 100 * 0.3
      : avgFeedbackScore;

  if (
    feedbackCount === undefined &&
    avgFeedbackScore === undefined &&
    validationCount === undefined &&
    successfulValidationCount === undefined &&
    score === undefined
  ) {
    return undefined;
  }

  return {
    snapshotTimestamp: new Date().toISOString(),
    source: 'indexer',
    ...(score !== undefined ? { score } : {}),
    ...(feedbackCount !== undefined ? { feedbackCount } : {}),
    ...(avgFeedbackScore !== undefined ? { avgFeedbackScore } : {}),
    raw: {
      feedbackCount,
      feedbackScoreSum,
      validationCount,
      successfulValidationCount
    }
  };
}

function mapRow(row: AgentIndexRow): CanonicalAgentProfile | null {
  const chainId = toNumberOrUndefined(row.chainId);
  const tokenIdRaw = row.tokenId;
  if (!chainId || tokenIdRaw === undefined || tokenIdRaw === null) return null;
  const tokenId = String(tokenIdRaw);
  const services = buildServices(row);
  const trust = buildTrust(row);
  const ownerAddress = lowerHexOrUndefined(row.owner) ?? lowerHexOrUndefined(row.agentWallet);
  const registrationsJson = toStringOrUndefined(row.registrationsJson);
  const name = toStringOrUndefined(row.name);
  const description = toStringOrUndefined(row.description);
  const imageUrl = toStringOrUndefined(row.imageUrl);

  return {
    chainId,
    tokenId,
    ...(ownerAddress ? { ownerAddress } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(typeof row.x402Supported === 'boolean' ? { x402Supported: row.x402Supported } : {}),
    services,
    ...(trust ? { trust } : {}),
    sourceMetadata: {
      onchainResolved: true,
      indexerResolved: true
    },
    raw: {
      tokenURI: row.tokenURI ?? null,
      active: row.active ?? null,
      supportedTrust: row.supportedTrust ?? null,
      registrationsJson: registrationsJson ?? null
    }
  };
}

async function postGraphql<T>(
  fetchImpl: typeof fetch,
  endpointUrl: string,
  timeoutMs: number,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetchImpl(endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`envio graphql request failed: ${response.status} ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`envio graphql returned non-json payload: ${text.slice(0, 240)}`);
  }
}

function hasErrors(payload: { errors?: Array<{ message?: string }> }): boolean {
  return Array.isArray(payload.errors) && payload.errors.length > 0;
}

function isUnknownQueryFieldError(payload: GraphqlRowsPayload): boolean {
  const errors = payload.errors ?? [];
  return errors.some((entry) => {
    const message = (entry.message ?? '').toLowerCase();
    const isHasuraMissingField =
      message.includes('field') && message.includes('not found') && message.includes('query_root');
    const isGraphqlMissingField =
      message.includes('cannot query field') && message.includes('on type') && message.includes('query_root');
    return isHasuraMissingField || isGraphqlMissingField;
  });
}

function withTableField(template: string, tableField: string): string {
  return template.replaceAll('__TABLE_FIELD__', tableField);
}

async function postGraphqlWithTableFallback(
  fetchImpl: typeof fetch,
  endpointUrl: string,
  timeoutMs: number,
  queryTemplate: string,
  variables: Record<string, unknown>
): Promise<GraphqlRowsPayload> {
  let lastPayload: GraphqlRowsPayload | undefined;

  for (const tableField of TABLE_FIELD_CANDIDATES) {
    const payload = await postGraphql<GraphqlRowsPayload>(
      fetchImpl,
      endpointUrl,
      timeoutMs,
      withTableField(queryTemplate, tableField),
      variables
    );
    lastPayload = payload;
    if (!hasErrors(payload)) return payload;
    if (!isUnknownQueryFieldError(payload)) return payload;
  }

  return lastPayload ?? {};
}

function filterProfilesByQuery(profiles: CanonicalAgentProfile[], query: string): CanonicalAgentProfile[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return profiles;
  return profiles.filter(
    (profile) =>
      (profile.name ?? '').toLowerCase().includes(q) ||
      (profile.description ?? '').toLowerCase().includes(q) ||
      profile.tokenId.toLowerCase().includes(q)
  );
}

export function createEnvioGraphqlProvider(config: EnvioGraphqlProviderConfig): DirectoryProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    name: 'envio-graphql',

    resolveAgent: async (input: ResolveAgentInput): Promise<CanonicalAgentProfile | null> => {
      const payload = await postGraphqlWithTableFallback(
        fetchImpl,
        config.endpointUrl,
        timeoutMs,
        RESOLVE_QUERY_TEMPLATE,
        { chainId: String(input.chainId), tokenId: input.tokenId }
      );

      if (hasErrors(payload)) {
        const message = payload.errors?.map((entry) => entry.message ?? 'unknown graphql error').join('; ');
        throw new Error(`envio graphql resolve error: ${message}`);
      }

      const row = payload.data?.rows?.[0];
      if (!row) return null;
      return mapRow(row);
    },

    search: async (input: SearchAgentsInput): Promise<CanonicalAgentProfile[]> => {
      const payload = await postGraphqlWithTableFallback(
        fetchImpl,
        config.endpointUrl,
        timeoutMs,
        input.chainId !== undefined ? SEARCH_QUERY_TEMPLATE : SEARCH_QUERY_ALL_CHAINS_TEMPLATE,
        input.chainId !== undefined
          ? {
              limit: input.limit ?? 20,
              offset: input.offset ?? 0,
              chainId: String(input.chainId)
            }
          : {
              limit: input.limit ?? 20,
              offset: input.offset ?? 0
            }
      );

      if (hasErrors(payload)) {
        const message = payload.errors?.map((entry) => entry.message ?? 'unknown graphql error').join('; ');
        throw new Error(`envio graphql search error: ${message}`);
      }

      const rows = payload.data?.rows ?? [];
      const profiles = rows.map(mapRow).filter((entry): entry is CanonicalAgentProfile => Boolean(entry));
      if (input.query) {
        return filterProfilesByQuery(profiles, input.query);
      }
      return profiles;
    }
  };
}
