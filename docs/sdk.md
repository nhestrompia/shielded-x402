# SDK API Surface

## Client SDK

- `deposit(amount, ownerPkHash)`
- `buildSpendProof({ note, witness, nullifierSecret, merchantPubKey, merchantRho?, merchantAddress, changeRho?, amount, challengeNonce, encryptedReceipt })`
- `buildSpendProofWithProvider(...)` (same params, injects real proof via configured ProofProvider)
- `pay402(shieldedPaymentResponse)`
- `prepare402Payment(requirement, note, witness, nullifierSecret, baseHeaders?)` (prebuild headers before request)
- `fetchWithShieldedPayment(url, init, note, witness, nullifierSecret)`
- `createShieldedFetch({ sdk, resolveContext, fetchImpl?, onUnsupportedRail?, prefetchRequirement?, relayerEndpoint?, relayerPath?, challengeUrlResolver? })`
- `createShieldedFetch({ ..., onRelayerSettlement? })` (hook for relayer settlement deltas)
- `createRelayedShieldedFetch(...)` (low-level explicit relayer variant; `createShieldedFetch` is the preferred single entrypoint)
- `createAgentPaymentFetch({ sdk, directoryClient?, resolveContext, targetPolicy?, requirementAdapters? })`
- `selectCounterpartyEndpoint(profile, policy?)` (deterministic ranking for fixed trust snapshots)
- `createGenericX402V2Adapter()` + custom requirement adapter chain support
- `FileBackedWalletState` (local persistent note + Merkle state indexer)
- Optional in-process proving:
  - `createNoirJsProofProvider({ noir, backend })`
  - configure via `ShieldedClientConfig.proofProvider`
  - easiest default artifact path: `createNoirJsProofProviderFromDefaultCircuit()`
  - circuit-backed providers default to `keccakZK` UltraHonk proof settings (matches generated onchain verifier in this repo)
  - override if needed:
    - `createNoirJsProofProviderFromDefaultCircuit({ backendProofOptions: { keccak: true } })` for `evm-no-zk` verifier targets

### ERC-8004 Agent Discovery + A2A Fetch

Use `@shielded-x402/erc8004-adapter` to resolve an ERC-8004 agent profile and route to the best endpoint, while keeping settlement in the existing relayer flow.

```ts
import {
  ShieldedClientSDK,
  createAgentPaymentFetch,
  createNoirJsProofProviderFromDefaultCircuit
} from "@shielded-x402/client";
import {
  createErc8004DirectoryClient,
  createEnvioGraphqlProvider,
  createOnchainRegistryProvider,
  createScanApiProvider
} from "@shielded-x402/erc8004-adapter";
```

Recommended provider order for production:

1. `createEnvioGraphqlProvider` (your own indexer endpoint),
2. `createOnchainRegistryProvider` (canonical fallback),
3. `createScanApiProvider` (public fallback).

`createAgentPaymentFetch` target forms:

- `{ type: "url", url }`
- `{ type: "erc8004", chainId, tokenId, isTestnet? }`

Error codes:

- `E_DIRECTORY_UNAVAILABLE`
- `E_AGENT_NOT_FOUND`
- `E_NO_COMPATIBLE_ENDPOINT`
- `E_402_NORMALIZATION_FAILED`
- `E_PAYMENT_EXECUTION_FAILED`

Selection determinism:

- deterministic for a fixed profile/trust snapshot
- tie-break order: protocol preference -> health -> trust score -> last active -> lexical endpoint

### Plug-and-Play Proof Generation (NoirJS)

Use NoirJS + bb.js once at startup, then all agent calls can use `fetchWithShieldedPayment()` directly.

```ts
import { ShieldedClientSDK, createNoirJsProofProviderFromDefaultCircuit } from "@shielded-x402/client";

const proofProvider = await createNoirJsProofProviderFromDefaultCircuit();

const sdk = new ShieldedClientSDK({
  endpoint: "http://localhost:3000",
  signer: async (message) => wallet.signMessage(message),
  proofProvider
});
```

Note:
- Circuit uses several `Field` private inputs. Inputs like `rho`, `pkHash`, and `nullifierSecret` must be field-safe values (< BN254 modulus).

### Easiest Agent Integration (`fetch` wrapper)

If you want a single drop-in function for agents, wrap the SDK once:

```ts
import { ShieldedClientSDK, createNoirJsProofProviderFromDefaultCircuit, createShieldedFetch } from "@shielded-x402/client";

const sdk = new ShieldedClientSDK({
  endpoint: "http://localhost:3000",
  signer: async (message) => wallet.signMessage(message),
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit()
});

const shieldedFetch = createShieldedFetch({
  sdk,
  prefetchRequirement: async () => {
    const r = await fetch("http://localhost:3000/x402/requirement");
    if (!r.ok) return null;
    return (await r.json()).requirement;
  },
  resolveContext: async () => ({
    note: walletState.currentSpendableNote,
    witness: walletState.currentWitness,
    nullifierSecret: walletState.currentNullifierSecret
  })
});

const response = await shieldedFetch("http://localhost:3000/paid/data", { method: "GET" });
```

`createShieldedFetch` does:
- optional prefetch of challenge requirement (if provided)
- first request (can already include payment headers in prefetch mode)
- strict `PAYMENT-REQUIRED` parsing
- shielded proof/signature generation
- retry with `PAYMENT-SIGNATURE` header

### No-Merchant-Change Integration (Single Entry: `createShieldedFetch`)

Use the same wrapper and add `relayerEndpoint` when merchants remain standard x402 and a centralized relayer performs onchain settlement + payout.

```ts
import {
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createShieldedFetch
} from "@shielded-x402/client";

const sdk = new ShieldedClientSDK({
  endpoint: "http://merchant.example",
  signer: async (message) => wallet.signMessage(message),
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit()
});

const relayedFetch = createShieldedFetch({
  sdk,
  relayerEndpoint: "http://localhost:3100",
  challengeUrlResolver: ({ input }) => `${new URL(input).origin}/x402/requirement`,
  resolveContext: async () => ({
    note: walletState.currentSpendableNote,
    witness: walletState.currentWitness,
    nullifierSecret: walletState.currentNullifierSecret
  })
});

const response = await relayedFetch("http://merchant.example/paid/data", { method: "GET" });
```

Relayed mode (`relayerEndpoint` set) does:
- first request to merchant to obtain the 402 challenge
- if merchant rail is not `shielded-usdc`, calls relayer bridge endpoint (`/v1/relay/challenge`) to mint a shielded requirement from merchant terms
- local proof generation/signing on the agent
- submits bundle to `/v1/relay/pay`
- returns the relayer-mediated merchant response
- relays request/response bodies as base64 bytes to avoid binary corruption (images/video/files)

### Local Incremental Indexer (Recommended for Agents)

Use `FileBackedWalletState` to persist note secrets + Merkle commitments and sync only new pool events.

```ts
import {
  FileBackedWalletState,
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createShieldedFetch
} from '@shielded-x402/client';

const walletState = await FileBackedWalletState.create({
  filePath: './agent-wallet-state.json',
  rpcUrl: process.env.SEPOLIA_RPC_URL, // optional when indexerGraphqlUrl is set
  indexerGraphqlUrl: process.env.WALLET_INDEXER_URL, // Envio hosted endpoint (recommended)
  shieldedPoolAddress: process.env.SHIELDED_POOL_ADDRESS as `0x${string}`,
  startBlock: 37697000n,
  confirmations: 2n,
  chunkSize: 2000n
});

// After a deposit tx, persist note data once:
await walletState.addOrUpdateNote(noteWithSecrets, noteNullifierSecret, depositBlockNumber);

// Before each payment, cheap incremental sync:
await walletState.sync();

const shieldedFetch = createShieldedFetch({
  sdk,
  relayerEndpoint: process.env.RELAYER_ENDPOINT,
  resolveContext: async () => walletState.getSpendContextByCommitment(noteWithSecrets.commitment),
  onRelayerSettlement: async ({ relayResponse, prepared }) => {
    await walletState.applyRelayerSettlement({
      settlementDelta: relayResponse.settlementDelta,
      changeNote: prepared.changeNote,
      changeNullifierSecret: prepared.changeNullifierSecret
    });
  }
});
```

Why this is better:
- avoids expensive full-range log scans each request
- keeps witness construction local for better privacy
- updates a file after interactions, so next run resumes from `lastSyncedBlock`
- writes settlement deltas automatically (new change note + leaf indexes) when relayer returns them
- can sync from Envio GraphQL (`indexerGraphqlUrl`) to avoid free-tier RPC `eth_getLogs` range caps

Compatibility note:
- `FileBackedWalletState` now uses `wallet-state.json` schema `version: 2` and stores note-level `nullifierSecret`.
- Older state files should be regenerated when upgrading from pre-0.3.0 SDK builds.

Note encryption utilities:
- `generateNoteEncryptionKeyPair()`
- `encryptNoteForPublicKey(note, recipientPublicKey)`
- `decryptNoteWithPrivateKey(ciphertext, recipientPrivateKey)`
- `encryptNoteSymmetric(note, key)` / `decryptNoteSymmetric(ciphertext, key)`

## Merchant SDK

- `issue402()`
- `verifyShieldedPayment(paymentSignatureHeader)`
- `confirmSettlement(nullifier, txHash?)`
- `decryptAndWithdraw({ encryptedNote, recipient, amount?, claimId?, deadline? })`

Withdrawal signing support:
- `createLocalWithdrawalSigner(privateKey)`
- Hook: `signWithdrawalDigest(digest)`
