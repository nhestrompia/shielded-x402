import { describe, expect, it, vi } from 'vitest';
import { createScanApiProvider } from './scanApiProvider.js';

describe('createScanApiProvider', () => {
  it('maps resolveAgent payload into canonical profile', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/v1/agents/8453/1434')) {
        return new Response(
          JSON.stringify({
            chain_id: 8453,
            token_id: '1434',
            contract_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
            owner_address: '0xF36bb95548Ae036B8AdD44f94CD0D01316825a20',
            name: 'Meerkat James',
            description: 'Agent description',
            x402_supported: true,
            services: {
              a2a: {
                endpoint: 'https://agent.example/.well-known/agent-card.json',
                version: '1.0.0',
                skills: ['tooling']
              }
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/v1/stats/agents/8453/1434')) {
        return new Response(
          JSON.stringify({
            overall_score: 91.2,
            total_feedbacks: 12,
            average_feedback_score: 94.5,
            health_status: 'healthy'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const provider = createScanApiProvider({ baseUrl: 'https://scan.example', fetchImpl });
    const profile = await provider.resolveAgent({ chainId: 8453, tokenId: '1434' });
    expect(profile).toBeTruthy();
    expect(profile?.chainId).toBe(8453);
    expect(profile?.x402Supported).toBe(true);
    expect(profile?.services[0]?.protocol).toBe('a2a');
    expect(profile?.trust?.source).toBe('indexer');
    expect(profile?.trust?.score).toBe(91.2);
  });

  it('search returns mapped rows', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              chain_id: 84532,
              token_id: '820',
              name: 'RyanClaw',
              description: 'AI agent assistant',
              x402_supported: true
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const provider = createScanApiProvider({ baseUrl: 'https://scan.example', fetchImpl });
    const rows = await provider.search?.({ chainId: 84532, isTestnet: true, limit: 1 });
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.tokenId).toBe('820');
  });
});
