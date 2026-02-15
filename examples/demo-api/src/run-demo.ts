import {
  ShieldedClientSDK,
  buildWitnessFromCommitments,
  createRelayedShieldedFetch
} from '@shielded-x402/client';
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

  const merchantUrl = process.env.DEMO_MERCHANT_URL ?? 'http://localhost:3000/paid/data';
  const relayerEndpoint = process.env.DEMO_RELAYER_ENDPOINT;

  const response = relayerEndpoint
    ? await createRelayedShieldedFetch({
        sdk,
        relayerEndpoint,
        challengeUrlResolver: ({ input }) => `${new URL(input).origin}/x402/requirement`,
        resolveContext: async () => ({
          note: deposited.note,
          witness,
          payerPkHash: ownerPkHash
        })
      })(merchantUrl, { method: 'GET' })
    : await sdk.fetchWithShieldedPayment(
        merchantUrl,
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
