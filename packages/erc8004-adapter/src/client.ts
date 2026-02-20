import type {
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  CanonicalTrustSnapshot
} from '@shielded-x402/shared-types';
import type {
  Erc8004DirectoryClient,
  Erc8004DirectoryClientConfig,
  DirectoryProfileFilter,
  ResolveAgentInput,
  SearchAgentsInput
} from './types.js';

interface CacheEntry {
  expiresAt: number;
  value: CanonicalAgentProfile | null;
}

function mergeProfileFilters(
  defaultFilter: DirectoryProfileFilter | undefined,
  inputFilter: DirectoryProfileFilter | undefined
): DirectoryProfileFilter | undefined {
  if (!defaultFilter && !inputFilter) return undefined;

  const defaultPredicate = defaultFilter?.predicate;
  const inputPredicate = inputFilter?.predicate;
  const predicate =
    defaultPredicate && inputPredicate
      ? (profile: CanonicalAgentProfile) => defaultPredicate(profile) && inputPredicate(profile)
      : inputPredicate ?? defaultPredicate;

  const merged: DirectoryProfileFilter = {
    x402Support: inputFilter?.x402Support ?? defaultFilter?.x402Support ?? 'any'
  };

  const hasServiceUrl = inputFilter?.hasServiceUrl ?? defaultFilter?.hasServiceUrl;
  if (hasServiceUrl !== undefined) {
    merged.hasServiceUrl = hasServiceUrl;
  }

  const allowedProtocols = inputFilter?.allowedProtocols ?? defaultFilter?.allowedProtocols;
  if (allowedProtocols !== undefined) {
    merged.allowedProtocols = allowedProtocols;
  }

  if (predicate) {
    merged.predicate = predicate;
  }

  return merged;
}

function applyProfileFilter(
  profile: CanonicalAgentProfile | null,
  filter: DirectoryProfileFilter | undefined
): CanonicalAgentProfile | null {
  if (!profile || !filter) return profile;

  let filtered = profile;
  if (filter.allowedProtocols && filter.allowedProtocols.length > 0) {
    const allowedProtocols = new Set(filter.allowedProtocols);
    const services = filtered.services.filter((service) => allowedProtocols.has(service.protocol));
    if (services.length === 0) return null;
    filtered = services.length === filtered.services.length ? filtered : { ...filtered, services };
  }

  if (filter.hasServiceUrl) {
    const hasServiceUrl = filtered.services.some(
      (service) => typeof service.url === 'string' && service.url.trim().length > 0
    );
    if (!hasServiceUrl) return null;
  }

  if (filter.x402Support === 'required_true' && filtered.x402Supported !== true) {
    return null;
  }

  if (filter.x402Support === 'exclude_false' && filtered.x402Supported === false) {
    return null;
  }

  if (filter.predicate && !filter.predicate(filtered)) {
    return null;
  }

  return filtered;
}

function keyForResolve(input: ResolveAgentInput): string {
  return `${input.chainId}:${input.tokenId}:${input.isTestnet === true ? 'testnet' : 'mainnet'}`;
}

function profileId(profile: CanonicalAgentProfile): string {
  return `${profile.chainId}:${profile.tokenId}`;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function mergeServices(profiles: CanonicalAgentProfile[]): CanonicalServiceEndpoint[] {
  const map = new Map<string, CanonicalServiceEndpoint>();
  for (const profile of profiles) {
    for (const service of profile.services) {
      const serviceKey = `${service.protocol}:${service.url ?? service.identifier ?? ''}`;
      const existing = map.get(serviceKey);
      if (!existing) {
        map.set(serviceKey, { ...service });
        continue;
      }
      map.set(serviceKey, {
        ...existing,
        ...service,
        capabilities: Array.from(
          new Set([...(existing.capabilities ?? []), ...(service.capabilities ?? [])])
        )
      });
    }
  }
  return [...map.values()];
}

function mergeTrust(profiles: CanonicalAgentProfile[]): CanonicalTrustSnapshot | undefined {
  const trustEntries = profiles
    .map((profile) => profile.trust)
    .filter((value): value is CanonicalTrustSnapshot => Boolean(value));
  if (trustEntries.length === 0) return undefined;

  const bySource = trustEntries.reduce(
    (acc, entry) => {
      if (entry.source === 'indexer') acc.indexer = entry;
      else if (entry.source === 'onchain') acc.onchain = entry;
      else acc.merged = entry;
      return acc;
    },
    {} as {
      indexer?: CanonicalTrustSnapshot;
      onchain?: CanonicalTrustSnapshot;
      merged?: CanonicalTrustSnapshot;
    }
  );

  return bySource.indexer ?? bySource.merged ?? bySource.onchain ?? trustEntries[0];
}

function mergeProfiles(
  profiles: CanonicalAgentProfile[]
): CanonicalAgentProfile | null {
  if (profiles.length === 0) return null;

  const first = profiles[0];
  if (!first) return null;

  const onchainFirst = profiles.find((profile) => profile.sourceMetadata.onchainResolved);
  const metadataPreferred = [...profiles].sort((a, b) => {
    const aMetadataOnly = a.sourceMetadata.onchainResolved ? 0 : 1;
    const bMetadataOnly = b.sourceMetadata.onchainResolved ? 0 : 1;
    return bMetadataOnly - aMetadataOnly;
  });
  const base = onchainFirst ?? first;

  const merged: CanonicalAgentProfile = {
    chainId: base.chainId,
    tokenId: base.tokenId,
    services: mergeServices(profiles),
    sourceMetadata: {
      onchainResolved: profiles.some((profile) => profile.sourceMetadata.onchainResolved),
      indexerResolved: profiles.some((profile) => profile.sourceMetadata.indexerResolved)
    }
  };

  const preferredIdentity = onchainFirst ?? first;
  if (preferredIdentity.registryAddress) {
    merged.registryAddress = preferredIdentity.registryAddress;
  }
  if (preferredIdentity.ownerAddress) {
    merged.ownerAddress = preferredIdentity.ownerAddress;
  }
  const name = firstDefined(metadataPreferred.map((profile) => profile.name));
  const description = firstDefined(metadataPreferred.map((profile) => profile.description));
  const imageUrl = firstDefined(metadataPreferred.map((profile) => profile.imageUrl));
  if (name) merged.name = name;
  if (description) merged.description = description;
  if (imageUrl) merged.imageUrl = imageUrl;

  const x402Source =
    profiles.find((profile) => profile.x402Supported !== undefined) ?? first;
  if (x402Source.x402Supported !== undefined) {
    merged.x402Supported = x402Source.x402Supported;
  }

  const trust = mergeTrust(profiles);
  if (trust) {
    merged.trust = trust;
  }

  const rawEntries = profiles.map((profile) => profile.raw).filter(Boolean);
  if (rawEntries.length > 0) {
    merged.raw = {
      mergedFrom: rawEntries
    };
  }

  return merged;
}

async function runOptionalTrustEnrichment(
  profile: CanonicalAgentProfile,
  getter:
    | ((input: ResolveAgentInput) => Promise<CanonicalTrustSnapshot | null>)
    | undefined,
  input: ResolveAgentInput
): Promise<CanonicalAgentProfile> {
  if (profile.trust || !getter) return profile;
  const trust = await getter(input);
  if (!trust) return profile;
  return {
    ...profile,
    trust: { ...trust, source: trust.source ?? 'indexer' },
    ...(profile.raw ? { raw: profile.raw } : {})
  };
}

export function createErc8004DirectoryClient(
  config: Erc8004DirectoryClientConfig
): Erc8004DirectoryClient {
  if (!config.providers || config.providers.length === 0) {
    throw new Error('createErc8004DirectoryClient requires at least one provider');
  }

  const cacheTtlMs = config.cacheTtlMs ?? 30_000;
  const resolveCache = new Map<string, CacheEntry>();

  return {
    resolveAgent: async (input: ResolveAgentInput): Promise<CanonicalAgentProfile | null> => {
      const effectiveFilter = mergeProfileFilters(config.defaultFilter, input.filter);
      const cacheKey = keyForResolve(input);
      const cached = resolveCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return applyProfileFilter(cached.value, effectiveFilter);
      }

      const resolvedProfiles: CanonicalAgentProfile[] = [];
      const providerErrors: string[] = [];

      for (const provider of config.providers) {
        try {
          const profile = await provider.resolveAgent(input);
          if (!profile) continue;
          const enriched = await runOptionalTrustEnrichment(
            profile,
            provider.getTrust,
            input
          );
          resolvedProfiles.push(enriched);
        } catch (error) {
          providerErrors.push(
            `${provider.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (resolvedProfiles.length === 0 && providerErrors.length === config.providers.length) {
        throw new Error(`directory unavailable: ${providerErrors.join('; ')}`);
      }

      const merged = mergeProfiles(resolvedProfiles);
      resolveCache.set(cacheKey, {
        value: merged,
        expiresAt: Date.now() + cacheTtlMs
      });
      return applyProfileFilter(merged, effectiveFilter);
    },

    search: async (input: SearchAgentsInput): Promise<CanonicalAgentProfile[]> => {
      const effectiveFilter = mergeProfileFilters(config.defaultFilter, input.filter);
      const byId = new Map<string, CanonicalAgentProfile[]>();
      const providerErrors: string[] = [];

      for (const provider of config.providers) {
        if (!provider.search) continue;
        try {
          const rows = await provider.search(input);
          for (const row of rows) {
            const id = profileId(row);
            const bucket = byId.get(id);
            if (bucket) bucket.push(row);
            else byId.set(id, [row]);
          }
        } catch (error) {
          providerErrors.push(
            `${provider.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (byId.size === 0 && providerErrors.length > 0) {
        throw new Error(`directory search unavailable: ${providerErrors.join('; ')}`);
      }

      return [...byId.values()]
        .map((bucket) => mergeProfiles(bucket))
        .map((profile) => applyProfileFilter(profile, effectiveFilter))
        .filter((value): value is CanonicalAgentProfile => Boolean(value));
    }
  };
}
