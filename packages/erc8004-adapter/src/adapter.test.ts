import { describe, expect, it, vi } from 'vitest';
import { Erc8004Adapter } from './index.js';

describe('Erc8004Adapter', () => {
  it('returns null when disabled', async () => {
    const adapter = new Erc8004Adapter({ enabled: false });
    await expect(adapter.resolveAgent('did:example:abc')).resolves.toBeNull();
  });

  it('fetches agent when enabled', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            did: 'did:example:abc',
            endpoint: 'https://example.com',
            encryptionPubKey:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            capabilities: ['payment'],
            supportedRails: ['shielded-usdc'],
            signature:
              '0x2222222222222222222222222222222222222222222222222222222222222222'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const adapter = new Erc8004Adapter({
      enabled: true,
      registryUrl: 'https://registry.example'
    });

    const result = await adapter.resolveAgent('did:example:abc');
    expect(result?.did).toBe('did:example:abc');

    fetchMock.mockRestore();
  });
});
