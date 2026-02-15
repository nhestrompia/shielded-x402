# SDK API Surface

## Client SDK

- `deposit(amount, ownerPkHash)`
- `buildSpendProof({ note, witness, nullifierSecret, merchantPubKey, merchantRho?, merchantAddress, changeRho?, amount, challengeNonce, encryptedReceipt })`
- `buildSpendProofWithProvider(...)` (same params, injects real proof via configured ProofProvider)
- `pay402(shieldedPaymentResponse)`
- `prepare402Payment(requirement, note, witness, payerPkHash, baseHeaders?)` (prebuild headers before request)
- `fetchWithShieldedPayment(url, init, note, witness, payerPkHash)`
- `createShieldedFetch({ sdk, resolveContext, fetchImpl?, onUnsupportedRail?, prefetchRequirement? })`
- `createRelayedShieldedFetch({ sdk, relayerEndpoint, resolveContext, challengeUrlResolver?, onUnsupportedRail?, fetchImpl? })`
- Optional in-process proving:
  - `createNoirJsProofProvider({ noir, backend })`
  - configure via `ShieldedClientConfig.proofProvider`
  - easiest default artifact path: `createNoirJsProofProviderFromDefaultCircuit()`

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
    payerPkHash: walletState.payerPkHash
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

### No-Merchant-Change Integration (`createRelayedShieldedFetch`)

Use this wrapper when merchants remain standard x402 and a centralized relayer performs onchain settlement + payout.

```ts
import {
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createRelayedShieldedFetch
} from "@shielded-x402/client";

const sdk = new ShieldedClientSDK({
  endpoint: "http://merchant.example",
  signer: async (message) => wallet.signMessage(message),
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit()
});

const relayedFetch = createRelayedShieldedFetch({
  sdk,
  relayerEndpoint: "http://localhost:3100",
  challengeUrlResolver: ({ input }) => `${new URL(input).origin}/x402/requirement`,
  resolveContext: async () => ({
    note: walletState.currentSpendableNote,
    witness: walletState.currentWitness,
    payerPkHash: walletState.payerPkHash
  })
});

const response = await relayedFetch("http://merchant.example/paid/data", { method: "GET" });
```

`createRelayedShieldedFetch` does:
- first request to merchant to obtain the 402 challenge
- local proof generation/signing on the agent
- submits bundle to `/v1/relay/pay`
- returns the relayer-mediated merchant response

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
