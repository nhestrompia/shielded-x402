import { ShieldedClientSDK, buildWitnessFromCommitments } from '@shielded-x402/client';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

async function run(): Promise<void> {
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f09453842c9f9f4d6f8f8fcaef4f8f16c5b6f4c0'
  );
  const sdk = new ShieldedClientSDK({
    endpoint: 'http://localhost:3000',
    signer: async (message) => account.signMessage({ message })
  });

  const ownerPkHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
  const deposited = await sdk.deposit(1_000_000n, ownerPkHash);

  const commitments = [deposited.note.commitment];
  const witness = buildWitnessFromCommitments(commitments, 0);

  const response = await sdk.fetchWithShieldedPayment(
    'http://localhost:3000/paid/data',
    { method: 'GET' },
    deposited.note,
    witness,
    ownerPkHash
  );

  const body = await response.text();
  console.log(`status=${response.status}`);
  console.log(body);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
