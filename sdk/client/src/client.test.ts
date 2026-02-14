import { X402_HEADERS, type Hex } from '@shielded-x402/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import { deriveCommitment } from './crypto.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('ShieldedClientSDK', () => {
  it('builds a spend payload with expected fields', () => {
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig'
    });

    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000022',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;

    const bundle = sdk.buildSpendProof({
      note,
      witness: {
        root: '0x0000000000000000000000000000000000000000000000000000000000000099',
        path: [],
        indexBits: []
      },
      nullifierSecret: note.pkHash,
      merchantPubKey: note.pkHash,
      merchantRho: '0x00000000000000000000000000000000000000000000000000000000000000aa',
      merchantAddress: '0x0000000000000000000000000000000000000001',
      changeRho: '0x00000000000000000000000000000000000000000000000000000000000000bb',
      amount: 30n,
      challengeNonce: note.rho,
      encryptedReceipt: '0x'
    });

    expect(bundle.response.nullifier.startsWith('0x')).toBe(true);
    expect(bundle.merchantRho).toBe('0x00000000000000000000000000000000000000000000000000000000000000aa');
    expect(bundle.response.merchantCommitment).toBe(
      deriveCommitment(
        30n,
        '0x00000000000000000000000000000000000000000000000000000000000000aa',
        note.pkHash
      )
    );
    expect(bundle.changeNote.amount).toBe(70n);
    expect(bundle.changeNote.rho).toBe('0x00000000000000000000000000000000000000000000000000000000000000bb');
  });

  it('fetchWithShieldedPayment uses configured proof provider output', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: '0x0000000000000000000000000000000000000000000000000000000000000033',
      leafIndex: 0
    } as const;
    const witness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099',
      path: new Array<string>(32).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(32).fill(0)
    };

    const providerProof = '0x1234' as Hex;
    const proofProvider = {
      generateProof: vi.fn(async ({ expectedPublicInputs }) => ({
        proof: providerProof,
        publicInputs: expectedPublicInputs
      }))
    };

    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig',
      proofProvider
    });

    const requirement = {
      rail: 'shielded-usdc',
      amount: '40',
      challengeNonce:
        '0x9999999999999999999999999999999999999999999999999999999999999999',
      challengeExpiry: String(Date.now() + 60_000),
      merchantPubKey:
        '0x0000000000000000000000000000000000000000000000000000000000000012',
      verifyingContract: '0x0000000000000000000000000000000000000002'
    } as const;

    const first = new Response(null, {
      status: 402,
      headers: {
        [X402_HEADERS.paymentRequirement]: JSON.stringify(requirement)
      }
    });
    const second = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await sdk.fetchWithShieldedPayment(
      'http://localhost:3000/paid/data',
      { method: 'GET' },
      note,
      witness,
      note.pkHash
    );

    expect(result.status).toBe(200);
    expect(proofProvider.generateProof).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const retryHeaders = new Headers(retryInit.headers);
    const payload = retryHeaders.get(X402_HEADERS.paymentResponse);
    expect(payload).toBeTruthy();
    const parsed = JSON.parse(payload ?? '{}') as { proof: string };
    expect(parsed.proof).toBe(providerProof);
  });

  it('buildSpendProofWithProvider replaces placeholder proof', async () => {
    const note = {
      amount: 100n,
      rho: '0x0000000000000000000000000000000000000000000000000000000000000011',
      pkHash: '0x0000000000000000000000000000000000000000000000000000000000000009',
      commitment: deriveCommitment(
        100n,
        '0x0000000000000000000000000000000000000000000000000000000000000011',
        '0x0000000000000000000000000000000000000000000000000000000000000009'
      ),
      leafIndex: 0
    } as const;
    const witness = {
      root: '0x0000000000000000000000000000000000000000000000000000000000000099',
      path: new Array<string>(32).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) as Hex[],
      indexBits: new Array<number>(32).fill(0)
    };
    const proofProvider = {
      generateProof: vi.fn(async ({ expectedPublicInputs }) => ({
        proof: '0x55',
        publicInputs: expectedPublicInputs
      }))
    };
    const sdk = new ShieldedClientSDK({
      endpoint: 'http://localhost:3000',
      signer: async () => '0xsig',
      proofProvider
    });

    const bundle = await sdk.buildSpendProofWithProvider({
      note,
      witness,
      nullifierSecret: note.pkHash,
      merchantPubKey:
        '0x0000000000000000000000000000000000000000000000000000000000000012',
      merchantAddress: '0x0000000000000000000000000000000000000002',
      amount: 40n,
      challengeNonce:
        '0x9999999999999999999999999999999999999999999999999999999999999999',
      encryptedReceipt: '0x'
    });

    expect(bundle.response.proof).toBe('0x55');
    expect(proofProvider.generateProof).toHaveBeenCalledTimes(1);
  });
});
