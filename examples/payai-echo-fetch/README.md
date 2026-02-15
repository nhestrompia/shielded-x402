# PayAI x402 Example (Commercial Facilitator Path)

This example calls:

- `https://x402.payai.network/api/base-sepolia/paid-content`

using standard x402 tooling (`x402-fetch`) on Base Sepolia.

## Run

```bash
cd shielded-402/examples/payai-echo-fetch
npm install
cp .env.example .env
# set PRIVATE_KEY in .env
npm run start
```

## What this demonstrates

- Standard x402 client flow against a commercial facilitator-backed endpoint.
- Works for normal x402 rails.

## Where this differs from Shielded x402

- This script does **not** use the shielded proof/relayer flow from this repo.
- For `shielded-usdc`, your facilitator must support your custom rail logic:
  - challenge binding checks
  - proof verification
  - `ShieldedPool.submitSpend(...)` settlement

If a commercial facilitator does not support those, you still need your own relayer for shielded payments.
