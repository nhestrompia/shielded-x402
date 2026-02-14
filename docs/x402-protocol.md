# x402 Wire Contract (Shielded Rail)

This implementation uses strict retry headers:

- `PAYMENT-RESPONSE`
- `PAYMENT-SIGNATURE`

Challenge header used by merchant gateway:

- `x-payment-requirement`

Additional replay-binding header used for nonce routing:

- `X-CHALLENGE-NONCE`

## 402 challenge payload

```json
{
  "rail": "shielded-usdc",
  "amount": "1000000",
  "challengeNonce": "0x...",
  "challengeExpiry": "<unix-ms>",
  "merchantPubKey": "0x...",
  "verifyingContract": "0x..."
}
```

## PAYMENT-RESPONSE payload

```json
{
  "proof": "0x...",
  "publicInputs": ["0x...", "0x...", "0x...", "0x...", "0x...", "0x..."],
  "nullifier": "0x...",
  "root": "0x...",
  "merchantCommitment": "0x...",
  "changeCommitment": "0x...",
  "challengeHash": "0x...",
  "encryptedReceipt": "0x...",
  "txHint": "leaf:<index>"
}
```
