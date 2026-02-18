import type {
  CanonicalAgentProfile,
  CanonicalTrustSnapshot,
  ServiceProtocol
} from '@shielded-x402/shared-types';

export interface DirectoryProfileFilter {
  hasServiceUrl?: boolean;
  allowedProtocols?: ServiceProtocol[];
  x402Support?: 'any' | 'exclude_false' | 'required_true';
  predicate?: (profile: CanonicalAgentProfile) => boolean;
}

export interface ResolveAgentInput {
  chainId: number;
  tokenId: string;
  isTestnet?: boolean;
  filter?: DirectoryProfileFilter;
}

export interface SearchAgentsInput {
  chainId?: number;
  isTestnet?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
  filter?: DirectoryProfileFilter;
}

export interface DirectoryProvider {
  name: string;
  resolveAgent(input: ResolveAgentInput): Promise<CanonicalAgentProfile | null>;
  search?(input: SearchAgentsInput): Promise<CanonicalAgentProfile[]>;
  getTrust?(input: ResolveAgentInput): Promise<CanonicalTrustSnapshot | null>;
}

export interface Erc8004DirectoryClientConfig {
  providers: DirectoryProvider[];
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  defaultFilter?: DirectoryProfileFilter;
}

export interface Erc8004DirectoryClient {
  resolveAgent(input: ResolveAgentInput): Promise<CanonicalAgentProfile | null>;
  search(input: SearchAgentsInput): Promise<CanonicalAgentProfile[]>;
}
