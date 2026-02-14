import { describe, expect, it } from 'vitest';
import { ShieldedClientSDK } from './client.js';
import { deriveCommitment } from './crypto.js';

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
});
