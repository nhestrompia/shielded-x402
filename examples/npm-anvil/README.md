# npm Anvil Consumer Example

This example validates the **published npm packages** in a real consumer setup against the local Anvil gateway flow.

## 1) Install dependencies in this folder

```bash
cd shielded-402/examples/npm-anvil
npm init -y
npm i @shielded-x402/client @noir-lang/noir_js @aztec/bb.js viem
```

## 2) Ensure Anvil stack is running

Run your local Anvil + gateway setup and keep it running while executing this script.

You can follow:

- `shielded-402/docs/testing-playbook.md`
- or `shielded-402/docs/agents-guide.md` (Anvil section)

## 3) Run this example

```bash
cd shielded-402/examples/npm-anvil
node test-anvil.mjs
```

Expected output:

- `status: 200`
- JSON body with `ok: true`

This script uses prefetch by default:

- calls `GET /x402/requirement`
- generates/signs proof headers
- sends the paid request with headers in the first call

## Optional env overrides

- `GATEWAY_URL` (default: `http://127.0.0.1:3000`)
- `PAYER_PRIVATE_KEY` (default: a local Anvil key)
- `PREFETCH_REQUIREMENT=false` to disable prefetch and use classic 402 retry flow
