import { describe, expect, it, vi } from 'vitest';
import { CRYPTO_SPEC, type Hex } from '@shielded-x402/shared-types';
import { createNoirJsProofProvider } from './proofProvider.js';
import type { ProofProviderRequest } from './types.js';

const MERKLE_DEPTH = CRYPTO_SPEC.merkleTreeDepth;

function expandCompactPublicInputs(inputs: Hex[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const word = inputs[i] ?? '0x';
    const hex = word.slice(2).padStart(64, '0');
    for (let j = 0; j < 32; j += 1) {
      const byteHex = hex.slice(j * 2, j * 2 + 2);
      out.push(`0x${BigInt(`0x${byteHex}`).toString(16)}`);
    }
  }
  const amount = inputs[5] ?? '0x0';
  out.push(`0x${BigInt(amount).toString(16)}`);
  return out;
}

function sampleRequest(): ProofProviderRequest {
  return {
    note: {
      amount: 100n,
      rho: '0x000000000000000000000000000000000000000000000000000000000000002a',
      pkHash: '0x000000000000000000000000000000000000000000000000000000000000000b',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000001',
      leafIndex: 0
    },
    witness: {
      root: '0x0000000000000000000000000000000000000000000000000000000000000002',
      path: new Array<Hex>(MERKLE_DEPTH).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ),
      indexBits: new Array<number>(MERKLE_DEPTH).fill(0)
    },
    nullifierSecret: '0x0000000000000000000000000000000000000000000000000000000000000009',
    merchantPubKey: '0x0000000000000000000000000000000000000000000000000000000000000012',
    merchantRho: '0x0000000000000000000000000000000000000000000000000000000000000034',
    changePkHash: '0x0000000000000000000000000000000000000000000000000000000000000013',
    changeRho: '0x0000000000000000000000000000000000000000000000000000000000000035',
    amount: 40n,
    challengeNonce:
      '0x9999999999999999999999999999999999999999999999999999999999999999',
    merchantAddress: '0x0000000000000000000000000000000000000002',
    expectedPublicInputs: [
      '0x23256f1f8b65c48a17008b455dd42ea504663e2dbf37ef29f2a93bf290a165c0',
      '0x759fe9862f9687b478adee7e744481d24c16b9fff12de191e6f3fae65e7d9981',
      '0x47c5e5b764f4199c9e70b237f38db00bd6bc26415f59a670e06b1b428fc8456e',
      '0x42844c8297765eaf977d418b33d294a94bcd9c80b21547795db47d3897116314',
      '0xdbb3dfdc3fe2b6b539cd7e296285a960ae4bd43befb8c899730b476da546559c',
      '0x0000000000000000000000000000000000000000000000000000000000000028'
    ]
  };
}

describe('createNoirJsProofProvider', () => {
  it('normalizes proof/public inputs from backend output', async () => {
    const request = sampleRequest();
    const execute = vi.fn(async () => ({ witness: 'w' }));
    const generateProof = vi.fn(async () => ({
      proof: new Uint8Array([1, 2, 3]),
      publicInputs: expandCompactPublicInputs(request.expectedPublicInputs)
    }));

    const provider = createNoirJsProofProvider({
      noir: { execute },
      backend: { generateProof }
    });

    const result = await provider.generateProof(request);
    expect(result.proof).toBe('0x010203');
    expect(result.publicInputs).toEqual(request.expectedPublicInputs);

    const inputArg = execute.mock.calls[0]?.[0] as { note_amount: string; pay_amount: string };
    expect(inputArg.note_amount).toBe('100');
    expect(inputArg.pay_amount).toBe('40');
  });

  it('throws when a field input exceeds BN254 modulus', async () => {
    const request = sampleRequest();
    request.note.pkHash =
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const provider = createNoirJsProofProvider({
      noir: { execute: async () => ({ witness: 'w' }) },
      backend: { generateProof: async () => ({ proof: '0x01', publicInputs: request.expectedPublicInputs }) }
    });

    await expect(provider.generateProof(request)).rejects.toThrow(
      'note.pkHash exceeds BN254 field modulus'
    );
  });
});
