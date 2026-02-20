import type { CanonicalAgentProfile } from '@shielded-x402/shared-types';
import { describe, expect, it } from 'vitest';
import { selectCounterpartyEndpoint } from './counterpartyPolicy.js';

function makeProfile(): CanonicalAgentProfile {
  return {
    chainId: 84532,
    tokenId: '1434',
    x402Supported: true,
    services: [
      { protocol: 'web', url: 'https://b.example.com/pay' },
      { protocol: 'a2a', url: 'https://agent.example.com/a2a' },
      { protocol: 'web', url: 'https://a.example.com/pay' }
    ],
    trust: {
      snapshotTimestamp: new Date('2026-02-17T00:00:00.000Z').toISOString(),
      source: 'indexer',
      score: 78,
      healthStatus: 'healthy',
      lastActiveAt: new Date('2026-02-17T00:00:00.000Z').toISOString()
    },
    sourceMetadata: {
      onchainResolved: true,
      indexerResolved: true
    }
  };
}

describe('selectCounterpartyEndpoint', () => {
  it('is deterministic for a fixed profile snapshot', () => {
    const profile = makeProfile();
    const first = selectCounterpartyEndpoint(profile);
    const second = selectCounterpartyEndpoint(profile);

    expect(first.selected?.endpoint.url).toBe('https://agent.example.com/a2a');
    expect(second.selected?.endpoint.url).toBe('https://agent.example.com/a2a');
    expect(first.candidates.map((c) => c.endpoint.url)).toEqual(
      second.candidates.map((c) => c.endpoint.url)
    );
  });

  it('uses lexical endpoint tie-break inside same protocol rank', () => {
    const profile = makeProfile();
    const selection = selectCounterpartyEndpoint(profile, {
      preferredProtocols: ['web']
    });
    expect(selection.candidates[0]?.endpoint.url).toBe('https://a.example.com/pay');
    expect(selection.candidates[1]?.endpoint.url).toBe('https://b.example.com/pay');
  });

  it('applies policy filters and explainability', () => {
    const profile = makeProfile();
    const selection = selectCounterpartyEndpoint(profile, {
      requireHttps: true,
      minTrustScore: 90
    });
    expect(selection.selected).toBeUndefined();
    expect(selection.candidates.every((c) => c.rejectionReasons.length > 0)).toBe(true);
    expect(selection.candidates[0]?.rankScoreBreakdown).toBeTruthy();
  });
});

