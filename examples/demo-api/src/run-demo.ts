import {
  ShieldedClientSDK,
  buildWitnessFromCommitments
} from '@shielded-x402/client';
import { X402_HEADERS, parsePaymentRequiredHeader } from '@shielded-x402/shared-types';
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
  const first = await fetch(merchantUrl, { method: 'GET' });
  if (first.status !== 402) {
    throw new Error(`expected 402 from merchant, got ${first.status}`);
  }
  const header = first.headers.get(X402_HEADERS.paymentRequired);
  if (!header) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }
  const requirement = parsePaymentRequiredHeader(header);
  const prepared = await sdk.prepare402Payment(
    requirement,
    deposited.note,
    witness,
    '0x0000000000000000000000000000000000000000000000000000000000000009'
  );
  const response = await fetch(merchantUrl, {
    method: 'GET',
    headers: prepared.headers
  });

  const body = await response.text();
  console.log(`status=${response.status}`);
  console.log(body);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
