import { describe, expect, it, vi } from 'vitest';
import { createCreditCloseClient } from './creditClose.js';

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe('createCreditCloseClient', () => {
  it('calls relayer close routes and parses responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'DONE',
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            txHash: '0x1111111111111111111111111111111111111111111111111111111111111111'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'DONE',
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            txHash: '0x2222222222222222222222222222222222222222222222222222222222222222'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'DONE',
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
            paidToAgent: '1',
            paidToRelayer: '2'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            exists: true,
            closing: true
          }),
          { status: 200 }
        )
      );

    const client = createCreditCloseClient({
      relayerEndpoint: 'http://relayer.local',
      fetchImpl: asFetch(fetchMock)
    });

    const latestState = {
      state: {
        channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        seq: '5',
        available: '60',
        cumulativeSpent: '40',
        lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        updatedAt: '1700000000',
        agentAddress: '0x0000000000000000000000000000000000000001',
        relayerAddress: '0x0000000000000000000000000000000000000002'
      },
      agentSignature:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b',
      relayerSignature:
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b'
    } as const;

    await client.startClose(latestState);
    await client.challengeClose({
      ...latestState,
      state: {
        ...latestState.state,
        seq: '6'
      }
    });
    const finalized = await client.finalizeClose(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    const status = await client.getCloseStatus(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );

    expect(finalized.status).toBe('DONE');
    expect(status.exists).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://relayer.local/v1/relay/credit/close/start');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://relayer.local/v1/relay/credit/close/challenge'
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'http://relayer.local/v1/relay/credit/close/finalize'
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'http://relayer.local/v1/relay/credit/close/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });
});
