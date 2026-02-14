# SDK API Surface

## Client SDK

- `deposit(amount, ownerPkHash)`
- `buildSpendProof({ note, witness, nullifierSecret, merchantPubKey, merchantRho?, merchantAddress, changeRho?, amount, challengeNonce, encryptedReceipt })`
- `buildSpendProofWithProvider(...)` (same params, injects real proof via configured ProofProvider)
- `pay402(shieldedPaymentResponse)`
- `fetchWithShieldedPayment(url, init, note, witness, payerPkHash)`
- `createShieldedFetch({ sdk, resolveContext, fetchImpl?, onUnsupportedRail? })`
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
  resolveContext: async () => ({
    note: walletState.currentSpendableNote,
    witness: walletState.currentWitness,
    payerPkHash: walletState.payerPkHash
  })
});

const response = await shieldedFetch("http://localhost:3000/paid/data", { method: "GET" });
```

`createShieldedFetch` does:
- first request
- `402` parsing
- shielded proof/signature generation
- retry with strict x402 headers

Note encryption utilities:
- `generateNoteEncryptionKeyPair()`
- `encryptNoteForPublicKey(note, recipientPublicKey)`
- `decryptNoteWithPrivateKey(ciphertext, recipientPrivateKey)`
- `encryptNoteSymmetric(note, key)` / `decryptNoteSymmetric(ciphertext, key)`

## Merchant SDK

- `issue402()`
- `verifyShieldedPayment(paymentResponseHeader, paymentSignatureHeader, { challengeNonce })`
- `confirmSettlement(nullifier, txHash?)`
- `decryptAndWithdraw({ encryptedNote, recipient, amount?, claimId?, deadline? })`

Withdrawal signing support:
- `createLocalWithdrawalSigner(privateKey)`
- Hook: `signWithdrawalDigest(digest)`
