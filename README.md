# Shielded x402

Monorepo for a privacy-preserving payment rail built with Noir + x402 + Solidity.

## Repository layout

- `/shielded-402/contracts` - Shielded pool contracts and Foundry tests.
- `/shielded-402/circuits/spend_change` - Noir circuit for spend + change.
- `/shielded-402/sdk/client` - Client payment SDK and note encryption.
- `/shielded-402/sdk/merchant` - Merchant challenge/verification + withdrawal signing.
- `/shielded-402/services/merchant-gateway` - Express middleware/service.
- `/shielded-402/packages/shared-types` - Shared payload and crypto constants.
- `/shielded-402/packages/erc8004-adapter` - Feature-flagged ERC-8004 adapter.
- `/shielded-402/examples/demo-api` - End-to-end demo client.

## Quickstart

1. Install dependencies: `pnpm install`
2. Install Foundry libs (Solady): `pnpm contracts:deps`
3. Validate tooling: `pnpm doctor`
4. Build all packages: `pnpm build`
5. Run tests: `pnpm test`
6. Run contract tests: `pnpm contracts:test`

## Noir workflow

- Check circuit: `pnpm circuit:check`
- Generate verifier artifact: `pnpm circuit:verifier`
- Generate payment fixture from proof outputs: `pnpm circuit:fixture`

## Demo flow

1. Start gateway: `pnpm --filter @shielded-x402/merchant-gateway dev`
2. Run client demo: `pnpm --filter @shielded-x402/demo-api demo`

## Agent Plug-and-Play (NoirJS)

- For in-process proof generation in agents, configure client SDK with `proofProvider` via `createNoirJsProofProviderFromDefaultCircuit()`.
- For a single-call integration, use `createShieldedFetch(...)` and replace direct `fetch` calls.
- See `shielded-402/docs/sdk.md` for setup snippet.

## High-Level Flow

```text
+---------------------+
|      Agent App      |
|  uses shieldedFetch |
+---------------------+
           |
           v
+---------------------+        402 challenge        +----------------------+
|   Merchant Gateway  | <-------------------------- | Initial API request  |
|   x402 middleware   | --------------------------> | from agent           |
+---------------------+                             +----------------------+
           |
           v
+-------------------------------------------------------------+
| Agent-side SDK (local)                                      |
| - buildSpendProofWithProvider()                             |
| - NoirJS + bb.js generates ZK proof                         |
| - signs PAYMENT-RESPONSE                                    |
+-------------------------------------------------------------+
           |
           v
+------------------------------+
| Retry API call with headers  |
| PAYMENT-RESPONSE             |
| PAYMENT-SIGNATURE            |
+------------------------------+
           |
           v
+--------------------------------------------------+
| Merchant verification                            |
| - verify proof                                   |
| - check root/nullifier onchain                   |
| - call ShieldedPool.submitSpend(...)             |
+--------------------------------------------------+
           |
           v
+----------------------+
| 200 OK to agent      |
| paid resource access |
+----------------------+
```

## Sepolia deployment

1. Copy env file: `cp .env.example .env`
2. Set `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_ADDRESS`
3. Generate verifier: `pnpm circuit:verifier`
4. Deploy verifier + adapter + pool: `pnpm deploy:sepolia`

## Live integration test

- Ensure gateway runs with Sepolia verifier/pool env values.
- Provide valid proof fixture JSON in `E2E_PAYMENT_RESPONSE_FILE`.
- Set `FIXED_CHALLENGE_NONCE` to the nonce used to generate that proof fixture.
- Run: `pnpm test:sepolia-live`

## Local Anvil dummy stack

- Start Anvil: `anvil --chain-id 31337`
- Deploy local stack: `pnpm deploy:anvil:dummy`
- This deploys `MockUSDC`, `MockProofVerifier`, `ShieldedPool`, `DummyShieldedService`.
- One-command local smoke test: `pnpm e2e:anvil`

## Agent integration

- Agent integration/testing guide: `/shielded-402/docs/agents-guide.md`
- Full testing playbook (Anvil + Sepolia): `/shielded-402/docs/testing-playbook.md`

## npm distribution

- Publish checklist and commands: `shielded-402/docs/publish-npm.md`
