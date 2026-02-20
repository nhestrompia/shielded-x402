import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '@shielded-x402/shared-types';
import { createOnchainRegistryProvider } from './onchainRegistryProvider.js';

function encodeAddressResult(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function encodeStringResult(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const lengthHex = bytes.length.toString(16).padStart(64, '0');
  const dataHex = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return `0x${'20'.padStart(64, '0')}${lengthHex}${dataHex}`;
}

describe('createOnchainRegistryProvider', () => {
  it('maps onchain identity + metadata to canonical profile', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://rpc.example.com') {
        const payload = JSON.parse(String(init?.body)) as { params: Array<{ data: string }> };
        const data = payload.params?.[0]?.data ?? '';
        if (data.startsWith('0x6352211e')) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: encodeAddressResult('0xABc0000000000000000000000000000000000001')
            }),
            { status: 200 }
          );
        }
        if (data.startsWith('0xc87b56dd')) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: encodeStringResult('https://metadata.example.com/agent/1434')
            }),
            { status: 200 }
          );
        }
      }
      const body = {
        name: 'Test Agent',
        description: 'Agent profile',
        image: 'https://cdn.example.com/agent.png',
        x402_supported: true,
        services: {
          a2a: { endpoint: 'https://agent.example.com/a2a', version: '1.0' },
          web: 'https://agent.example.com/http'
        }
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const provider = createOnchainRegistryProvider({
      registryByChain: { 84532: '0x1111111111111111111111111111111111111111' as Hex },
      rpcUrlByChain: { 84532: 'https://rpc.example.com' },
      fetchImpl
    });

    const profile = await provider.resolveAgent({
      chainId: 84532,
      tokenId: '1434',
      isTestnet: true
    });

    expect(profile).toBeTruthy();
    expect(profile?.ownerAddress).toBe('0xabc0000000000000000000000000000000000001');
    expect(profile?.x402Supported).toBe(true);
    expect(profile?.services.map((s) => s.protocol)).toEqual(['a2a', 'web']);
    expect(profile?.sourceMetadata.onchainResolved).toBe(true);
  });
});
