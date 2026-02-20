import type { Erc8004DirectoryClient } from '@shielded-x402/erc8004-adapter';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentPaymentError,
  type A2AResolvedCard,
  createAgentPaymentFetch,
  type AgentTarget
} from './agentPaymentFetch.js';

function makeCreditClient() {
  return {
    pay: vi.fn(async () => ({
      status: 'DONE' as const,
      merchantResult: {
        status: 200,
        headers: {},
        bodyBase64: Buffer.from('ok', 'utf8').toString('base64')
      }
    }))
  };
}

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

function makeDirectoryClient(
  resolveAgent: Erc8004DirectoryClient['resolveAgent']
): Erc8004DirectoryClient {
  return {
    resolveAgent,
    search: async () => []
  };
}

describe('createAgentPaymentFetch', () => {
  it('uses direct URL target without directory client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const creditClient = makeCreditClient();
    const agentFetch = createAgentPaymentFetch({
      creditClient,
      fetchImpl: asFetch(fetchMock)
    });

    const response = await agentFetch({ type: 'url', url: 'https://api.example.com/data' });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/data', {});
    expect(creditClient.pay).not.toHaveBeenCalled();
  });

  it('resolves erc8004 target and selects endpoint by policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const creditClient = makeCreditClient();
    const directoryClient = makeDirectoryClient(async () => ({
      chainId: 84532,
      tokenId: '1434',
      x402Supported: true,
      services: [
        { protocol: 'web', url: 'https://web.example.com/pay' },
        { protocol: 'a2a', url: 'https://a2a.example.com/pay' }
      ],
      sourceMetadata: {
        onchainResolved: true,
        indexerResolved: true
      }
    }));

    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      targetPolicy: { preferredProtocols: ['a2a', 'web'] },
      fetchImpl: asFetch(fetchMock)
    });

    const target: AgentTarget = { type: 'erc8004', chainId: 84532, tokenId: '1434' };
    await agentFetch(target);
    expect(fetchMock).toHaveBeenCalledWith('https://a2a.example.com/pay', {});
  });

  it('maps directory failures to typed errors', async () => {
    const directoryClient = makeDirectoryClient(async () => {
      throw new Error('directory unavailable');
    });
    const creditClient = makeCreditClient();
    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      fetchImpl: asFetch(vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))
    });

    await expect(
      agentFetch({ type: 'erc8004', chainId: 84532, tokenId: '1' })
    ).rejects.toMatchObject({
      code: 'E_DIRECTORY_UNAVAILABLE'
    } satisfies Partial<AgentPaymentError>);
  });

  it('returns E_NO_COMPATIBLE_ENDPOINT when policy rejects all services', async () => {
    const directoryClient = makeDirectoryClient(async () => ({
      chainId: 84532,
      tokenId: '1434',
      x402Supported: false,
      services: [{ protocol: 'web', url: 'http://insecure.example.com/pay' }],
      sourceMetadata: {
        onchainResolved: true,
        indexerResolved: true
      }
    }));

    const creditClient = makeCreditClient();
    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      fetchImpl: asFetch(vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))
    });

    await expect(
      agentFetch({ type: 'erc8004', chainId: 84532, tokenId: '1434' })
    ).rejects.toMatchObject({
      code: 'E_NO_COMPATIBLE_ENDPOINT'
    } satisfies Partial<AgentPaymentError>);
  });

  it('extracts x402 payment profiles from a2a card and exposes callback data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'answerbook-all',
            payments: [
              {
                method: 'x402',
                payee: '0x3205765176A38D82FD61fE0b2E0b1D2c7A76B00b',
                network: 'base-sepolia',
                endpoint: 'https://facilitator.world.fun/',
                extensions: {
                  x402: {
                    facilitatorUrl: 'https://facilitator.world.fun/'
                  }
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const creditClient = makeCreditClient();
    const onA2ACardResolved = vi.fn(async (_args: {
      card: A2AResolvedCard;
    }) => {});
    const directoryClient = makeDirectoryClient(async () => ({
      chainId: 84532,
      tokenId: '813',
      x402Supported: true,
      services: [
        { protocol: 'a2a', url: 'https://api.answerbook.app/.well-known/agent.json' }
      ],
      sourceMetadata: {
        onchainResolved: false,
        indexerResolved: true
      }
    }));

    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      onA2ACardResolved,
      fetchImpl: asFetch(fetchMock)
    });

    await agentFetch({ type: 'erc8004', chainId: 84532, tokenId: '813' });
    expect(onA2ACardResolved).toHaveBeenCalledTimes(1);
    expect(onA2ACardResolved.mock.calls[0]?.[0]?.card?.x402Payments?.[0]?.payee).toBe(
      '0x3205765176A38D82FD61fE0b2E0b1D2c7A76B00b'
    );
  });

  it('allows overriding invoke target after reading a2a card', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'answerbook-all',
            payments: [{ method: 'x402', payee: '0xabc', network: 'base-sepolia' }]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('paid', { status: 200 }));

    const creditClient = makeCreditClient();
    const directoryClient = makeDirectoryClient(async () => ({
      chainId: 84532,
      tokenId: '813',
      x402Supported: true,
      services: [
        { protocol: 'a2a', url: 'https://api.answerbook.app/.well-known/agent.json' }
      ],
      sourceMetadata: {
        onchainResolved: false,
        indexerResolved: true
      }
    }));

    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      resolveA2AInvokeTarget: async () => 'https://api.answerbook.app/invoke/ask',
      fetchImpl: asFetch(fetchMock)
    });

    const response = await agentFetch({ type: 'erc8004', chainId: 84532, tokenId: '813' });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.answerbook.app/invoke/ask',
      {}
    );
  });

  it('does not swallow resolveA2AInvokeTarget errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'answerbook-all',
            payments: [{ method: 'x402', payee: '0xabc', network: 'base-sepolia' }]
          }),
          { status: 200 }
        )
      );

    const creditClient = makeCreditClient();
    const directoryClient = makeDirectoryClient(async () => ({
      chainId: 84532,
      tokenId: '813',
      x402Supported: true,
      services: [
        { protocol: 'a2a', url: 'https://api.answerbook.app/.well-known/agent.json' }
      ],
      sourceMetadata: {
        onchainResolved: false,
        indexerResolved: true
      }
    }));

    const agentFetch = createAgentPaymentFetch({
      creditClient,
      directoryClient,
      resolveA2AInvokeTarget: async () => {
        throw new Error('no payable invoke endpoint');
      },
      fetchImpl: asFetch(fetchMock)
    });

    await expect(
      agentFetch({ type: 'erc8004', chainId: 84532, tokenId: '813' })
    ).rejects.toMatchObject({
      code: 'E_PAYMENT_EXECUTION_FAILED',
      message: 'no payable invoke endpoint'
    } satisfies Partial<AgentPaymentError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
