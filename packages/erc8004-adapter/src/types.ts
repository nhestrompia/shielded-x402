import type { CanonicalAgentProfile, CanonicalTrustSnapshot } from '@shielded-x402/shared-types';

export interface ResolveAgentInput {
  chainId: number;
  tokenId: string;
  isTestnet?: boolean;
}

export interface SearchAgentsInput {
  chainId?: number;
  isTestnet?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
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
}

export interface Erc8004DirectoryClient {
  resolveAgent(input: ResolveAgentInput): Promise<CanonicalAgentProfile | null>;
  search(input: SearchAgentsInput): Promise<CanonicalAgentProfile[]>;
}
