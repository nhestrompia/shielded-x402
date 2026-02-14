# SDK API Surface

## Client SDK

- `deposit(amount, ownerPkHash)`
- `buildSpendProof({ note, witness, nullifierSecret, merchantPubKey, merchantRho?, merchantAddress, changeRho?, amount, challengeNonce, encryptedReceipt })`
- `pay402(shieldedPaymentResponse)`
- `fetchWithShieldedPayment(url, init, note, witness, payerPkHash)`

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
