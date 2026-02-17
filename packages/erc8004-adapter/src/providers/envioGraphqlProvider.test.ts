import { describe, expect, it, vi } from 'vitest';
import { createEnvioGraphqlProvider } from './envioGraphqlProvider.js';

describe('createEnvioGraphqlProvider', () => {
  it('maps resolveAgent response into canonical profile', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            agentIndexProfiles: [
              {
                chainId: '84532',
                tokenId: '813',
                owner: '0x0b02ec18c8e4cff7dda06bc8178830c4021ca3ef',
                tokenURI: 'data:application/json;base64,eyJmb28iOiJiYXIifQ==',
                name: 'answerbook-all',
                description: 'test agent',
                x402Supported: true,
                a2aEndpoint: 'https://api.answerbook.app/.well-known/agent.json',
                feedbackCount: '2',
                feedbackScoreSum: '8',
                validationCount: '1',
                successfulValidationCount: '1'
              }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const provider = createEnvioGraphqlProvider({
      endpointUrl: 'https://indexer.example/v1/graphql',
      fetchImpl
    });

    const profile = await provider.resolveAgent({ chainId: 84532, tokenId: '813' });
    expect(profile).toBeTruthy();
    expect(profile?.tokenId).toBe('813');
    expect(profile?.x402Supported).toBe(true);
    expect(profile?.services[0]?.protocol).toBe('a2a');
    expect(profile?.services[0]?.url).toBe('https://api.answerbook.app/.well-known/agent.json');
    expect(profile?.trust?.feedbackCount).toBe(2);
    expect(profile?.trust?.avgFeedbackScore).toBe(4);
  });

  it('search filters by query client-side', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            agentIndexProfiles: [
              {
                chainId: '84532',
                tokenId: '813',
                name: 'answerbook-all',
                description: 'oracle',
                x402Supported: true
              },
              {
                chainId: '84532',
                tokenId: '814',
                name: 'other-agent',
                description: 'misc',
                x402Supported: false
              }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const provider = createEnvioGraphqlProvider({
      endpointUrl: 'https://indexer.example/v1/graphql',
      fetchImpl
    });

    const profiles = await provider.search?.({
      chainId: 84532,
      query: 'answerbook'
    });

    expect(profiles?.length).toBe(1);
    expect(profiles?.[0]?.tokenId).toBe('813');
  });
});
