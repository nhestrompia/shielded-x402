import type {
  CanonicalAgentProfile,
  CanonicalServiceEndpoint,
  Hex,
  ServiceProtocol
} from '@shielded-x402/shared-types';
import type { DirectoryProvider, ResolveAgentInput } from '../types.js';

interface OnchainRegistryProviderConfig {
  registryByChain: Record<number, Hex>;
  rpcUrlByChain: Record<number, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ipfsGatewayBaseUrl?: string;
}

const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const OWNER_OF_SELECTOR = '0x6352211e';
const TOKEN_URI_SELECTOR = '0xc87b56dd';
const AGENT_URI_SELECTOR = '0x78396cb3';

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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

function resolveUri(uri: string, ipfsGatewayBaseUrl: string): string {
  if (uri.startsWith('ipfs://')) {
    return `${ipfsGatewayBaseUrl.replace(/\/$/, '')}/${uri.slice('ipfs://'.length).replace(/^\//, '')}`;
  }
  return uri;
}

function padHexWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function decodeAddressWord(result: string): Hex | undefined {
  if (!result.startsWith('0x')) return undefined;
  const hex = result.slice(2);
  if (hex.length < 64) return undefined;
  const lastWord = hex.slice(-64);
  return `0x${lastWord.slice(24)}`.toLowerCase() as Hex;
}

function decodeAbiString(result: string): string | undefined {
  if (!result.startsWith('0x')) return undefined;
  const hex = result.slice(2);
  if (hex.length < 128) return undefined;
  const offset = Number.parseInt(hex.slice(0, 64), 16);
  if (!Number.isFinite(offset)) return undefined;
  const offsetPos = offset * 2;
  if (hex.length < offsetPos + 64) return undefined;
  const length = Number.parseInt(hex.slice(offsetPos, offsetPos + 64), 16);
  if (!Number.isFinite(length) || length < 0) return undefined;
  const dataStart = offsetPos + 64;
  const dataEnd = dataStart + length * 2;
  if (hex.length < dataEnd) return undefined;
  const dataHex = hex.slice(dataStart, dataEnd);
  try {
    return Buffer.from(dataHex, 'hex').toString('utf8');
  } catch {
    return undefined;
  }
}

async function ethCall(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  to: Hex,
  data: string,
  timeoutMs: number
): Promise<string | undefined> {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest']
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { result?: string; error?: unknown };
  if (payload.error) return undefined;
  return payload.result;
}

function normalizeServiceEntry(
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
  const url = toStringOrUndefined(record.endpoint) ?? toStringOrUndefined(record.url);
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

function servicesFromMetadata(metadata: Record<string, unknown>): CanonicalServiceEndpoint[] {
  const out: CanonicalServiceEndpoint[] = [];
  const services = metadata.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [key, value] of Object.entries(services as Record<string, unknown>)) {
      const mapped = normalizeServiceEntry(key, value);
      if (mapped) out.push(mapped);
    }
  }
  const endpoints = metadata.endpoints;
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    for (const [key, value] of Object.entries(endpoints as Record<string, unknown>)) {
      const mapped = normalizeServiceEntry(key, value);
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

async function readTokenUri(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  registryAddress: Hex,
  tokenId: bigint,
  timeoutMs: number
): Promise<string | undefined> {
  const encodedArg = padHexWord(tokenId);
  const tokenUriResult = await ethCall(
    fetchImpl,
    rpcUrl,
    registryAddress,
    `${TOKEN_URI_SELECTOR}${encodedArg}`,
    timeoutMs
  );
  const tokenUri = tokenUriResult ? decodeAbiString(tokenUriResult) : undefined;
  if (tokenUri) return tokenUri;

  const agentUriResult = await ethCall(
    fetchImpl,
    rpcUrl,
    registryAddress,
    `${AGENT_URI_SELECTOR}${encodedArg}`,
    timeoutMs
  );
  return agentUriResult ? decodeAbiString(agentUriResult) : undefined;
}

export function createOnchainRegistryProvider(
  config: OnchainRegistryProviderConfig
): DirectoryProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const ipfsGatewayBaseUrl = config.ipfsGatewayBaseUrl ?? DEFAULT_IPFS_GATEWAY;

  return {
    name: 'onchain-registry',

    resolveAgent: async (input: ResolveAgentInput): Promise<CanonicalAgentProfile | null> => {
      const registryAddress = config.registryByChain[input.chainId];
      const rpcUrl = config.rpcUrlByChain[input.chainId];
      if (!registryAddress || !rpcUrl) return null;

      const ownerResult = await ethCall(
        fetchImpl,
        rpcUrl,
        registryAddress,
        `${OWNER_OF_SELECTOR}${padHexWord(BigInt(input.tokenId))}`,
        timeoutMs
      );
      const ownerAddress = ownerResult ? decodeAddressWord(ownerResult) : undefined;
      if (!ownerAddress) return null;

      const uri = await readTokenUri(
        fetchImpl,
        rpcUrl,
        registryAddress,
        BigInt(input.tokenId),
        timeoutMs
      );
      let metadata: Record<string, unknown> | undefined;
      if (uri) {
        const resolved = resolveUri(uri, ipfsGatewayBaseUrl);
        try {
          const response = await fetchImpl(resolved, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (response.ok) {
            metadata = (await response.json()) as Record<string, unknown>;
          }
        } catch {
          metadata = undefined;
        }
      }

      const services = metadata ? servicesFromMetadata(metadata) : [];
      const x402SupportedRaw = metadata?.x402_supported ?? metadata?.x402Supported;
      const x402Supported = typeof x402SupportedRaw === 'boolean' ? x402SupportedRaw : undefined;
      const name = toStringOrUndefined(metadata?.name);
      const description = toStringOrUndefined(metadata?.description);
      const imageUrl = toStringOrUndefined(metadata?.image);

      return {
        chainId: input.chainId,
        tokenId: input.tokenId,
        registryAddress: registryAddress.toLowerCase() as Hex,
        ownerAddress,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(x402Supported !== undefined ? { x402Supported } : {}),
        services,
        sourceMetadata: {
          onchainResolved: true,
          indexerResolved: false
        },
        ...(metadata ? { raw: metadata } : {})
      };
    }
  };
}

