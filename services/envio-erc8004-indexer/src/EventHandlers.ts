import generated from 'generated';
import type {
  AgentIndexProfile,
  ReputationRegistry_FeedbackRevoked,
  ReputationRegistry_NewFeedback
} from 'generated';

const { IdentityRegistry, ReputationRegistry } = generated as unknown as {
  IdentityRegistry: typeof import('generated').IdentityRegistry;
  ReputationRegistry: typeof import('generated').ReputationRegistry;
};

function profileId(chainId: number | bigint, agentId: number | bigint | string): string {
  return `${chainId}_${String(agentId)}`;
}

function toBigInt(value: unknown, fallback: bigint = 0n): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toNullableString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function lowerAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase();
}

function bytesHexToUtf8OrHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('0x')) return value;
  try {
    const hex = value.slice(2);
    const text = Buffer.from(hex, 'hex').toString('utf8').replace(/\0+$/g, '').trim();
    return text.length > 0 ? text : value;
  } catch {
    return value;
  }
}

function parseDataUriJson(uri: string | undefined): Record<string, unknown> | undefined {
  if (!uri) return undefined;
  if (!uri.startsWith('data:application/json')) return undefined;
  const marker = ';base64,';
  const markerIndex = uri.indexOf(marker);
  if (markerIndex >= 0) {
    const encoded = uri.slice(markerIndex + marker.length);
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  const plainIndex = uri.indexOf(',');
  if (plainIndex >= 0) {
    const decoded = decodeURIComponent(uri.slice(plainIndex + 1));
    try {
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function readServices(
  registration: Record<string, unknown>
): {
  a2aEndpoint?: string;
  mcpEndpoint?: string;
  webEndpoint?: string;
  oasfEndpoint?: string;
  didIdentifier?: string;
  ensIdentifier?: string;
  emailIdentifier?: string;
} {
  const out: {
    a2aEndpoint?: string;
    mcpEndpoint?: string;
    webEndpoint?: string;
    oasfEndpoint?: string;
    didIdentifier?: string;
    ensIdentifier?: string;
    emailIdentifier?: string;
  } = {};

  const setService = (protocol: string, value: unknown): void => {
    if (!value) return;
    if (typeof value === 'string') {
      if (protocol === 'a2a') out.a2aEndpoint = value;
      if (protocol === 'mcp') out.mcpEndpoint = value;
      if (protocol === 'web') out.webEndpoint = value;
      if (protocol === 'oasf') out.oasfEndpoint = value;
      if (protocol === 'did') out.didIdentifier = value;
      if (protocol === 'ens') out.ensIdentifier = value;
      if (protocol === 'email') out.emailIdentifier = value;
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const endpoint =
      toNullableString(record.endpoint) ??
      toNullableString(record.url) ??
      toNullableString(record.identifier);
    if (!endpoint) return;
    if (protocol === 'a2a') out.a2aEndpoint = endpoint;
    if (protocol === 'mcp') out.mcpEndpoint = endpoint;
    if (protocol === 'web') out.webEndpoint = endpoint;
    if (protocol === 'oasf') out.oasfEndpoint = endpoint;
    if (protocol === 'did') out.didIdentifier = endpoint;
    if (protocol === 'ens') out.ensIdentifier = endpoint;
    if (protocol === 'email') out.emailIdentifier = endpoint;
  };

  const services = registration.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [name, value] of Object.entries(services as Record<string, unknown>)) {
      setService(name.trim().toLowerCase(), value);
    }
  }

  const endpoints = registration.endpoints;
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    for (const [name, value] of Object.entries(endpoints as Record<string, unknown>)) {
      setService(name.trim().toLowerCase(), value);
    }
  }

  if (Array.isArray(services)) {
    for (const entry of services) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const name = toNullableString(record.name)?.toLowerCase();
      const endpoint = toNullableString(record.endpoint) ?? toNullableString(record.url);
      if (!name || !endpoint) continue;
      setService(name, endpoint);
    }
  }

  return out;
}

function createEmptyProfile(
  id: string,
  chainId: bigint,
  tokenId: bigint,
  blockNumber: bigint,
  blockTimestamp: bigint
): AgentIndexProfile {
  return {
    id,
    chainId,
    tokenId,
    owner: undefined,
    agentWallet: undefined,
    tokenURI: undefined,
    name: undefined,
    description: undefined,
    imageUrl: undefined,
    active: undefined,
    x402Supported: undefined,
    supportedTrust: undefined,
    a2aEndpoint: undefined,
    mcpEndpoint: undefined,
    webEndpoint: undefined,
    oasfEndpoint: undefined,
    didIdentifier: undefined,
    ensIdentifier: undefined,
    emailIdentifier: undefined,
    registrationsJson: undefined,
    feedbackCount: 0n,
    feedbackScoreSum: 0n,
    feedbackRevokedCount: 0n,
    validationCount: 0n,
    successfulValidationCount: 0n,
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
}

async function getOrCreateProfile(
  context: { AgentIndexProfile: { get: (id: string) => Promise<AgentIndexProfile | undefined> } },
  chainId: number | bigint,
  agentId: number | bigint | string,
  blockNumber: bigint,
  blockTimestamp: bigint
): Promise<AgentIndexProfile> {
  const id = profileId(chainId, agentId);
  const existing = await context.AgentIndexProfile.get(id);
  if (existing) return existing;
  return createEmptyProfile(id, toBigInt(chainId), toBigInt(agentId), blockNumber, blockTimestamp);
}

function applyRegistrationData(profile: AgentIndexProfile, registration: Record<string, unknown>): AgentIndexProfile {
  const services = readServices(registration);
  const supportedTrust = Array.isArray(registration.supportedTrust)
    ? (registration.supportedTrust.filter((entry): entry is string => typeof entry === 'string').join(',') || undefined)
    : undefined;
  return {
    ...profile,
    ...(toNullableString(registration.name) ? { name: toNullableString(registration.name) } : {}),
    ...(toNullableString(registration.description)
      ? { description: toNullableString(registration.description) }
      : {}),
    ...(toNullableString(registration.image) ? { imageUrl: toNullableString(registration.image) } : {}),
    ...(readBoolean(registration.active) !== undefined
      ? { active: readBoolean(registration.active) }
      : {}),
    ...(readBoolean(registration.x402Support ?? registration.x402_supported) !== undefined
      ? { x402Supported: readBoolean(registration.x402Support ?? registration.x402_supported) }
      : {}),
    ...(supportedTrust ? { supportedTrust } : {}),
    ...services,
    registrationsJson: JSON.stringify(registration)
  };
}

IdentityRegistry.Transfer.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.tokenId,
    blockNumber,
    blockTimestamp
  );
  const owner = lowerAddress(toNullableString(event.params.to));
  const updated: AgentIndexProfile = {
    ...profile,
    ...(owner ? { owner } : {}),
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  context.AgentIndexProfile.set(updated);
});

IdentityRegistry.Registered.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.agentId,
    blockNumber,
    blockTimestamp
  );
  const tokenURI = toNullableString(event.params.tokenURI);
  const owner = lowerAddress(toNullableString(event.params.owner));
  let updated: AgentIndexProfile = {
    ...profile,
    ...(tokenURI ? { tokenURI } : {}),
    ...(owner ? { owner } : {}),
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  const registration = parseDataUriJson(tokenURI);
  if (registration) {
    updated = applyRegistrationData(updated, registration);
  }
  context.AgentIndexProfile.set(updated);
});

IdentityRegistry.URIUpdated.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.agentId,
    blockNumber,
    blockTimestamp
  );
  const tokenURI = toNullableString(event.params.newURI);
  let updated: AgentIndexProfile = {
    ...profile,
    ...(tokenURI ? { tokenURI } : {}),
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  const registration = parseDataUriJson(tokenURI);
  if (registration) {
    updated = applyRegistrationData(updated, registration);
  }
  context.AgentIndexProfile.set(updated);
});

IdentityRegistry.MetadataSet.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.agentId,
    blockNumber,
    blockTimestamp
  );
  const metadataKey =
    toNullableString(event.params.metadataKey)?.toLowerCase() ??
    toNullableString(event.params.indexedMetadataKey)?.toLowerCase();
  const metadataValue = bytesHexToUtf8OrHex(event.params.metadataValue);
  let updated: AgentIndexProfile = {
    ...profile,
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  if (metadataKey && metadataValue) {
    if (metadataKey === 'agentwallet') {
      updated = { ...updated, agentWallet: lowerAddress(metadataValue) };
    } else if (metadataKey === 'x402support' || metadataKey === 'x402_supported') {
      const bool = readBoolean(metadataValue);
      if (bool !== undefined) updated = { ...updated, x402Supported: bool };
    } else if (metadataKey === 'name') {
      updated = { ...updated, name: metadataValue };
    } else if (metadataKey === 'description') {
      updated = { ...updated, description: metadataValue };
    } else if (metadataKey === 'image') {
      updated = { ...updated, imageUrl: metadataValue };
    } else if (metadataKey === 'active') {
      const bool = readBoolean(metadataValue);
      if (bool !== undefined) updated = { ...updated, active: bool };
    }
  }
  context.AgentIndexProfile.set(updated);
});

ReputationRegistry.NewFeedback.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const entity: ReputationRegistry_NewFeedback = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    chainId: toBigInt(event.chainId),
    agentId: event.params.agentId,
    clientAddress: lowerAddress(toNullableString(event.params.clientAddress)) ?? '',
    feedbackIndex: toBigInt(event.params.feedbackIndex),
    value: toBigInt(event.params.value),
    valueDecimals: toBigInt(event.params.valueDecimals),
    indexedTag1: toNullableString(event.params.indexedTag1) ?? '',
    tag1: toNullableString(event.params.tag1) ?? '',
    tag2: toNullableString(event.params.tag2) ?? '',
    endpoint: toNullableString(event.params.endpoint) ?? '',
    feedbackURI: toNullableString(event.params.feedbackURI) ?? '',
    feedbackHash: toNullableString(event.params.feedbackHash) ?? ''
  };
  context.ReputationRegistry_NewFeedback.set(entity);

  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.agentId,
    blockNumber,
    blockTimestamp
  );
  const updated: AgentIndexProfile = {
    ...profile,
    feedbackCount: profile.feedbackCount + 1n,
    feedbackScoreSum: profile.feedbackScoreSum + toBigInt(event.params.value),
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  context.AgentIndexProfile.set(updated);
});

ReputationRegistry.FeedbackRevoked.handler(async ({ event, context }) => {
  const blockNumber = toBigInt(event.block.number);
  const blockTimestamp = toBigInt(event.block.timestamp);
  const entity: ReputationRegistry_FeedbackRevoked = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    chainId: toBigInt(event.chainId),
    agentId: event.params.agentId,
    clientAddress: lowerAddress(toNullableString(event.params.clientAddress)) ?? '',
    feedbackIndex: toBigInt(event.params.feedbackIndex)
  };
  context.ReputationRegistry_FeedbackRevoked.set(entity);

  const profile = await getOrCreateProfile(
    context,
    event.chainId,
    event.params.agentId,
    blockNumber,
    blockTimestamp
  );
  const updated: AgentIndexProfile = {
    ...profile,
    feedbackRevokedCount: profile.feedbackRevokedCount + 1n,
    lastUpdatedBlock: blockNumber,
    updatedAt: blockTimestamp
  };
  context.AgentIndexProfile.set(updated);
});
