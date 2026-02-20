import { describe, expect, it, vi } from 'vitest';
import type { CanonicalAgentProfile } from '@shielded-x402/shared-types';
import { createErc8004DirectoryClient } from './client.js';
import type { DirectoryProvider } from './types.js';

const onchainProfile: CanonicalAgentProfile = {
  chainId: 8453,
  tokenId: '1434',
  registryAddress: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  ownerAddress: '0x1111111111111111111111111111111111111111',
  name: 'Onchain Name',
  services: [{ protocol: 'a2a', url: 'https://agent.example/.well-known/agent-card.json' }],
  sourceMetadata: {
    onchainResolved: true,
    indexerResolved: false
  }
};

const noUrlProfile: CanonicalAgentProfile = {
  chainId: 8453,
  tokenId: '9000',
  name: 'No URL',
  services: [{ protocol: 'did', identifier: 'did:example:no-url' }],
  sourceMetadata: {
    onchainResolved: true,
    indexerResolved: false
  }
};

const indexerProfile: CanonicalAgentProfile = {
  chainId: 8453,
  tokenId: '1434',
  ownerAddress: '0x2222222222222222222222222222222222222222',
  name: 'Indexer Name',
  description: 'Indexer description',
  x402Supported: true,
  services: [
    { protocol: 'a2a', url: 'https://agent.example/.well-known/agent-card.json' },
    { protocol: 'web', url: 'https://agent.example' }
  ],
  trust: {
    snapshotTimestamp: new Date().toISOString(),
    source: 'indexer',
    score: 88
  },
  sourceMetadata: {
    onchainResolved: false,
    indexerResolved: true
  }
};

describe('createErc8004DirectoryClient', () => {
  it('merges profiles with onchain identity precedence and indexer trust enrichment', async () => {
    const providers: DirectoryProvider[] = [
      {
        name: 'onchain',
        resolveAgent: vi.fn(async () => onchainProfile)
      },
      {
        name: 'indexer',
        resolveAgent: vi.fn(async () => indexerProfile)
      }
    ];
    const client = createErc8004DirectoryClient({ providers, cacheTtlMs: 1_000 });
    const profile = await client.resolveAgent({ chainId: 8453, tokenId: '1434' });
    expect(profile).toBeTruthy();
    expect(profile?.ownerAddress).toBe(onchainProfile.ownerAddress);
    expect(profile?.description).toBe(indexerProfile.description);
    expect(profile?.x402Supported).toBe(true);
    expect(profile?.services.length).toBe(2);
    expect(profile?.trust?.score).toBe(88);
  });

  it('throws when all providers fail', async () => {
    const client = createErc8004DirectoryClient({
      providers: [
        {
          name: 'broken-a',
          resolveAgent: async () => {
            throw new Error('a down');
          }
        },
        {
          name: 'broken-b',
          resolveAgent: async () => {
            throw new Error('b down');
          }
        }
      ]
    });
    await expect(client.resolveAgent({ chainId: 8453, tokenId: '1' })).rejects.toThrow(
      'directory unavailable'
    );
  });

  it('uses cache for repeated resolve calls', async () => {
    const resolve = vi.fn(async () => onchainProfile);
    const client = createErc8004DirectoryClient({
      providers: [{ name: 'onchain', resolveAgent: resolve }],
      cacheTtlMs: 60_000
    });
    await client.resolveAgent({ chainId: 8453, tokenId: '1434' });
    await client.resolveAgent({ chainId: 8453, tokenId: '1434' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('applies default protocol/url/x402 filters on resolveAgent', async () => {
    const client = createErc8004DirectoryClient({
      providers: [
        {
          name: 'mixed',
          resolveAgent: async () => indexerProfile
        }
      ],
      defaultFilter: {
        allowedProtocols: ['web'],
        hasServiceUrl: true,
        x402Support: 'required_true'
      }
    });

    const profile = await client.resolveAgent({ chainId: 8453, tokenId: '1434' });
    expect(profile).toBeTruthy();
    expect(profile?.services).toEqual([{ protocol: 'web', url: 'https://agent.example' }]);
  });

  it('lets per-call filter override default x402 filter', async () => {
    const client = createErc8004DirectoryClient({
      providers: [
        {
          name: 'profile',
          resolveAgent: async () => ({ ...indexerProfile, x402Supported: false })
        }
      ],
      defaultFilter: {
        x402Support: 'required_true'
      }
    });

    const blocked = await client.resolveAgent({ chainId: 8453, tokenId: '1434' });
    expect(blocked).toBeNull();

    const allowed = await client.resolveAgent({
      chainId: 8453,
      tokenId: '1434',
      filter: { x402Support: 'exclude_false' }
    });
    expect(allowed).toBeNull();

    const allowAny = await client.resolveAgent({
      chainId: 8453,
      tokenId: '1434',
      filter: { x402Support: 'any' }
    });
    expect(allowAny).toBeTruthy();
  });

  it('applies filters in search results', async () => {
    const client = createErc8004DirectoryClient({
      providers: [
        {
          name: 'search-provider',
          resolveAgent: async () => null,
          search: async () => [indexerProfile, noUrlProfile]
        }
      ]
    });

    const filtered = await client.search({
      filter: {
        hasServiceUrl: true,
        allowedProtocols: ['a2a', 'web']
      }
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tokenId).toBe('1434');
  });
});
