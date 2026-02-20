import type {
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  CounterpartyCandidate,
  CounterpartySelectionResult,
  ServiceProtocol
} from '@shielded-x402/shared-types';

export interface CounterpartyPolicyConfig {
  preferredProtocols?: Array<'a2a' | 'web' | 'mcp' | 'oasf'>;
  minTrustScore?: number;
  requireX402Support?: boolean;
  requireHttps?: boolean;
}

const DEFAULT_PROTOCOLS: Array<'a2a' | 'web' | 'mcp' | 'oasf'> = ['a2a', 'web', 'mcp', 'oasf'];

function protocolPriority(protocol: ServiceProtocol, preferred: ServiceProtocol[]): number {
  const index = preferred.indexOf(protocol);
  return index >= 0 ? preferred.length - index : 0;
}

function normalizeHealthScore(health?: string): number {
  if (!health) return 0;
  if (health === 'healthy') return 10;
  if (health === 'degraded') return 5;
  return 0;
}

function normalizeTimestampScore(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  return Math.floor(time / 1000);
}

function toEndpointLabel(endpoint: CanonicalServiceEndpoint): string {
  return endpoint.url ?? endpoint.identifier ?? `${endpoint.protocol}:unknown`;
}

function buildCandidate(
  endpoint: CanonicalServiceEndpoint,
  profile: CanonicalAgentProfile,
  config: Required<Pick<CounterpartyPolicyConfig, 'requireHttps' | 'requireX402Support'>> &
    CounterpartyPolicyConfig
): CounterpartyCandidate {
  const rejectionReasons: string[] = [];

  if (!endpoint.url) {
    rejectionReasons.push('endpoint url missing');
  }
  if (config.requireHttps && endpoint.url && !endpoint.url.startsWith('https://')) {
    rejectionReasons.push('https required');
  }
  if (config.requireX402Support && profile.x402Supported === false) {
    rejectionReasons.push('counterparty does not advertise x402 support');
  }
  const trustScore = profile.trust?.score;
  if (config.minTrustScore !== undefined && trustScore !== undefined && trustScore < config.minTrustScore) {
    rejectionReasons.push(`trust score ${trustScore} below minimum ${config.minTrustScore}`);
  }

  const preferredProtocols = (config.preferredProtocols ?? DEFAULT_PROTOCOLS) as ServiceProtocol[];
  const protocolScore = protocolPriority(endpoint.protocol, preferredProtocols);
  const healthScore = normalizeHealthScore(profile.trust?.healthStatus);
  const trustScoreNormalized = trustScore ?? 0;
  const activityScore = normalizeTimestampScore(profile.trust?.lastActiveAt);
  const rankScoreBreakdown: Record<string, number> = {
    protocol: protocolScore,
    health: healthScore,
    trust: trustScoreNormalized,
    activity: activityScore
  };
  const rankScore =
    protocolScore * 1_000_000_000_000 +
    healthScore * 1_000_000_000 +
    trustScoreNormalized * 1_000_000 +
    activityScore;

  return {
    endpoint,
    rankScore,
    rejectionReasons,
    rankScoreBreakdown
  };
}

export function selectCounterpartyEndpoint(
  profile: CanonicalAgentProfile,
  policy: CounterpartyPolicyConfig = {}
): CounterpartySelectionResult {
  const options = {
    requireHttps: policy.requireHttps ?? true,
    requireX402Support: policy.requireX402Support ?? false,
    ...policy
  };

  const candidates = profile.services
    .map((endpoint) => buildCandidate(endpoint, profile, options))
    .sort((a, b) => {
      if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
      const aLabel = toEndpointLabel(a.endpoint);
      const bLabel = toEndpointLabel(b.endpoint);
      return aLabel.localeCompare(bLabel);
    });

  const selected = candidates.find((candidate) => candidate.rejectionReasons.length === 0);
  if (selected) {
    return {
      selected,
      candidates
    };
  }
  return { candidates };
}
