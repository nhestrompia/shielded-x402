# SDK API Surface

This repo is now credit-channel first:

- one proof-backed topup (`/v1/relay/credit/topup`)
- signature-only debits for each paid request (`/v1/relay/credit/pay`)

There is no automatic fallback to legacy proof-per-request HTTP relay mode.

## Packages

- `@shielded-x402/client`
- `@shielded-x402/shared-types`
- optional discovery: `@shielded-x402/erc8004-adapter`

## Core Client Exports

From `@shielded-x402/client`:

- `ShieldedClientSDK`
- `createCreditChannelClient`
- `createCreditShieldedFetch`
- `createCreditCloseClient`
- `createAgentPaymentFetch`
- `FileBackedWalletState`
- proof providers:
  - `createNoirJsProofProvider(...)`
  - `createNoirJsProofProviderFromCircuit(...)`
  - `createNoirJsProofProviderFromDefaultCircuit(...)`

From `@shielded-x402/shared-types`:

- `X402_HEADERS`
- `parsePaymentSignatureHeader`
- `parsePaymentRequiredHeader`
- `RELAYER_ROUTES`

## Recommended Flow

1. Keep notes + nullifier secrets in `FileBackedWalletState`.
2. Bootstrap channel credit with a proof-backed topup.
3. Use `createCreditShieldedFetch` for normal paid calls.
4. Persist returned signed credit state on each debit.

## Minimal Credit Fetch Example

```ts
import {
  createCreditChannelClient,
  createCreditShieldedFetch,
  FileBackedWalletState
} from '@shielded-x402/client';

const wallet = await FileBackedWalletState.create({
  filePath: './wallet-state.json',
  shieldedPoolAddress: process.env.SHIELDED_POOL_ADDRESS as `0x${string}`,
  indexerGraphqlUrl: process.env.WALLET_INDEXER_URL,
  rpcUrl: process.env.POOL_RPC_URL,
  startBlock: BigInt(process.env.POOL_FROM_BLOCK ?? '0')
});

const creditClient = createCreditChannelClient({
  relayerEndpoint: process.env.RELAYER_ENDPOINT!,
  // optional: channelId; if omitted, SDK derives deterministic id from relayer domain + agent address
  agentAddress: account.address,
  signer: {
    signTypedData: (args) => account.signTypedData(args)
  },
  stateStore: wallet
});

const creditFetch = createCreditShieldedFetch({ creditClient });
const response = await creditFetch('https://merchant.example/paid', { method: 'GET' });
```

## Topup Example (Proof -> Credit)

```ts
import {
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createCreditChannelClient,
  FileBackedWalletState
} from '@shielded-x402/client';
import {
  X402_HEADERS,
  parsePaymentSignatureHeader
} from '@shielded-x402/shared-types';
import { randomBytes } from 'node:crypto';

const sdk = new ShieldedClientSDK({
  endpoint: process.env.RELAYER_ENDPOINT!,
  signer: (message) => account.signMessage({ message }),
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit({
    backendProofOptions: { verifierTarget: 'evm' }
  })
});

const spendContext = wallet.getSpendContextByCommitment(spendableCommitment);

const prepared = await sdk.prepare402Payment(
  {
    x402Version: 2,
    scheme: 'exact',
    network: process.env.CREDIT_NETWORK!,
    asset: process.env.CREDIT_ASSET as `0x${string}`,
    payTo: process.env.CREDIT_PAY_TO as `0x${string}`,
    rail: 'shielded-usdc',
    amount: process.env.CREDIT_TOPUP_AMOUNT_MICROS!,
    challengeNonce: (`0x${randomBytes(32).toString('hex')}` as `0x${string}`),
    challengeExpiry: String(Math.floor(Date.now() / 1000) + 600),
    merchantPubKey: process.env.CREDIT_MERCHANT_PUBKEY as `0x${string}`,
    verifyingContract: process.env.CREDIT_VERIFYING_CONTRACT as `0x${string}`
  },
  spendContext.note,
  spendContext.witness,
  spendContext.nullifierSecret
);

const paymentSignatureHeader = prepared.headers.get(X402_HEADERS.paymentSignature)!;
const envelope = parsePaymentSignatureHeader(paymentSignatureHeader);

const topupResult = await creditClient.topup({
  requestId: `credit-topup-${Date.now()}`,
  paymentPayload: prepared.response,
  paymentPayloadSignature: envelope.signature
});

if (topupResult.status !== 'DONE') {
  throw new Error(topupResult.failureReason ?? 'credit topup failed');
}

await wallet.markNoteSpent(spendContext.note.commitment);
await wallet.addOrUpdateNote(prepared.changeNote, prepared.changeNullifierSecret);
```

## Close / Challenge / Finalize

```ts
import { createCreditCloseClient } from '@shielded-x402/client';

const closeClient = createCreditCloseClient({
  relayerEndpoint: process.env.RELAYER_ENDPOINT!
});

const latest = /* latest SignedCreditState for this agent/relayer */ wallet.getCreditState(
  '0x<channel-id>' as `0x${string}`
)!;
await closeClient.startClose(latest);
// if needed: await closeClient.challengeClose(higherState)
await closeClient.finalizeClose(latest.state.channelId);
```

## Agent-to-Agent Routing (ERC-8004)

Use `createAgentPaymentFetch` when the target can be either:

- direct URL
- ERC-8004 token reference

`createAgentPaymentFetch` resolves endpoint selection first, then always executes the credit fetch path.

## Wallet State Notes

`FileBackedWalletState` schema is `version: 3`.

It stores:

- notes + nullifier secrets
- commitments and sync cursor (`lastSyncedBlock`)
- latest signed credit state per `channelId`

Older wallet files should be regenerated for current builds.
