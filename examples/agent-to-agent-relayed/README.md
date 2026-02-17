# Agent-to-Agent Relayed Payment (ERC-8004 Discovery)

This example shows how to:

1. resolve an agent target via ERC-8004 providers (Envio GraphQL + onchain registry + optional scan API),
2. select a compatible endpoint with deterministic policy,
3. pay through the existing shielded relayer flow (`shielded-usdc`),
4. persist note state locally for subsequent calls.

## Run

```bash
cd /Users/nhestrompia/Projects/shielded-402
pnpm --filter @shielded-x402/shared-types build
pnpm --filter @shielded-x402/erc8004-adapter build
pnpm --filter @shielded-x402/client build

cd /Users/nhestrompia/Projects/shielded-402/examples/agent-to-agent-relayed
npm install
cp .env.example .env
npm run start
```

## Minimum env

- `RELAYER_ENDPOINT`
- `PAYER_PRIVATE_KEY`
- `SHIELDED_POOL_ADDRESS`
- `WALLET_INDEXER_URL` or `POOL_RPC_URL`

Target selection:

- Either set `TARGET_URL` directly, or
- set `ERC8004_TOKEN_ID` (+ provider config) for discovery mode, or
- leave `ERC8004_TOKEN_ID` empty and the example auto-selects one x402-capable agent from ERC-8004 search results.

Runtime behavior:

- For A2A endpoints, the script fetches the discovered agent card and derives invoke candidates.
- It probes candidates and prefers one that returns a real x402 challenge (`402` + x402 shape).
- With `A2A_REQUIRE_X402=true` (default), the run fails fast if discovery returns only free metadata endpoints.
- With `DISCOVERY_REQUIRE_PAYABLE=true` (default), auto-token discovery only accepts routes that are live and x402-payable.

Provider priority:

1. `ERC8004_ENVIO_GRAPHQL_URL` (your own Envio indexer),
2. onchain registry provider (`ERC8004_REGISTRY_ADDRESS` + `ERC8004_RPC_URL`),
3. scan API fallback (`ERC8004_SCAN_API_URL`).
