# Agent-to-Agent Relayed Payment (ERC-8004 Discovery)

This example shows how to:

1. resolve an agent target via ERC-8004 providers (Envio GraphQL + onchain registry + optional scan API),
2. select a compatible endpoint with deterministic policy,
3. bootstrap credit channel state with one proof-backed topup when missing,
4. pay through the credit channel relayer flow (signature-only debit),
5. persist co-signed credit state locally for subsequent calls.

## Run

```bash
cd /path/to/shielded-402
pnpm --filter @shielded-x402/shared-types build
pnpm --filter @shielded-x402/erc8004-adapter build
pnpm --filter @shielded-x402/client build

cd examples/agent-to-agent-relayed
npm install
cp .env.example .env
npm run seed-note
npm run start
```

## Minimum env

- `RELAYER_ENDPOINT`
- `PAYER_PRIVATE_KEY`
- `SHIELDED_POOL_ADDRESS`
- `WALLET_INDEXER_URL` or `POOL_RPC_URL`
- `CREDIT_CHANNEL_ID` (optional; if unset, SDK derives deterministic channel id)
- `CREDIT_TOPUP_IF_MISSING` (default `true`)
- `CREDIT_TOPUP_AMOUNT_MICROS` (default `1000000`)

Relayer safety default:

- relayer is fail-closed by default (`RELAYER_UNSAFE_DEV_MODE=false`)
- if verifier/settlement env is missing, relayer startup fails

Target selection:

- Either set `TARGET_URL` directly, or
- set `ERC8004_TOKEN_ID` (+ provider config) for discovery mode, or
- leave `ERC8004_TOKEN_ID` empty and the example auto-selects one x402-capable agent from ERC-8004 search results.

Runtime behavior:

- For A2A endpoints, the script fetches the discovered agent card and derives invoke candidates.
- It probes candidates and prefers one that returns a real x402 challenge (`402` + x402 shape).
- With `DISCOVERY_REQUIRE_PAYABLE=true` (default), auto-token discovery only accepts routes that are live and x402-payable.
- Debit calls use credit mode only and do not fall back to proof-per-request.
- If no co-signed credit state exists in wallet state, the script auto-topups once (`CREDIT_TOPUP_IF_MISSING=true`) using a spendable shielded note from the wallet.

Provider priority:

1. `ERC8004_ENVIO_GRAPHQL_URL` (your own Envio indexer),
2. onchain registry provider (`ERC8004_REGISTRY_ADDRESS` + `ERC8004_RPC_URL`),
3. scan API fallback (`ERC8004_SCAN_API_URL`).
