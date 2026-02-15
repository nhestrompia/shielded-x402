# Agent Integration Guide (Shielded x402)

This guide is for AI agents or agent frameworks that currently support normal x402 and want to use the shielded rail in this repo.

## What this rail is

- Payment protocol: x402 retry flow (`402 -> retry with payment headers`).
- Shielded rail id: `shielded-usdc`.
- Payment payload: proof bundle + public inputs (`ShieldedPaymentResponse`).
- Merchant gateway endpoints:
  - `GET /paid/data` (protected resource)
  - `GET /x402/requirement` (optional prefetch of a fresh challenge)
  - `GET /health`
  - `GET /agent/:did`, `GET /agent/:did/reputation`, `POST /agent` (ERC-8004 adapter endpoints, optional)
- Payment relayer endpoints:
  - `POST /v1/relay/pay`
  - `GET /v1/relay/status/:settlementId`
  - `GET /health`

## Merchant-side compatibility model

- Merchants keep the same x402 HTTP contract (`402` challenge + retry headers).
- Agent keeps proof generation local.
- Relayer verifies challenge/proof bindings, settles onchain, then executes merchant payout adapter.
- Merchant integration stays unchanged.

## Header contract (strict)

- Challenge response header: `PAYMENT-REQUIRED` (base64 x402 v2 envelope).
- Retry request header: `PAYMENT-SIGNATURE` (base64 signed payment envelope).

Use constants from `/shielded-402/packages/shared-types/src/x402.ts`.

## How agents should decide rail

Use this decision rule:

1. Send request normally.
2. If status is not `402`, return response.
3. Parse `PAYMENT-REQUIRED`.
4. If `rail === "shielded-usdc"`, run shielded flow.
5. Otherwise run your existing normal x402 flow.

This keeps compatibility with endpoints that may mix rails.

## Agent flow: shielded payment

### Prerequisite: agent must fund the shielded pool

Before any paid request, the agent must hold a spendable note:

1. Approve and deposit ERC-20 into `ShieldedPool`.
2. Index the `Deposited` event and derive/store:
   - note `{ amount, rho, pkHash, commitment, leafIndex }`
   - current Merkle witness for that note.
3. Only then can the agent generate a valid spend proof.

Without this deposit+note state, proof generation will succeed structurally but settlement will fail onchain.

1. Receive `402` and parse requirement:
   - `amount`
   - `challengeNonce`
   - `merchantPubKey`
   - `verifyingContract`
2. Build witness from local note/Merkle state.
3. Call client SDK:
   - preferred: `createRelayedShieldedFetch(...)` and call that wrapper instead of raw `fetch`
   - direct merchant mode: `createShieldedFetch(...)`
   - configure `proofProvider` with `createNoirJsProofProviderFromDefaultCircuit()` for in-process proving
4. Wrapper posts the proof bundle to relayer (`/v1/relay/pay`).
5. Relayer settles onchain and returns merchant response.
6. On `200`, treat as settled for API access.

Fast-start option for agents:

1. Call `GET /x402/requirement` first.
2. Start proof generation immediately with that nonce.
3. Send the paid request once headers are ready (often avoids an extra round trip).
4. If merchant returns `402` again (expired/stale nonce), request a new `PAYMENT-REQUIRED` and regenerate.

Reference implementation:

- `/shielded-402/sdk/client/src/client.ts`

## Example wrapper for mixed rails

```ts
import { ShieldedClientSDK } from "@shielded-x402/client";
import { X402_HEADERS } from "@shielded-x402/shared-types";

export async function fetchWithAnyRail(
  url: string,
  init: RequestInit,
  ctx: {
    shielded: ShieldedClientSDK;
    note: any;
    witness: any;
    payerPkHash: `0x${string}`;
    payNormalX402: (req: Response) => Promise<Response>;
  },
): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;

  const requirementRaw = first.headers.get(X402_HEADERS.paymentRequired);
  if (!requirementRaw) throw new Error("missing PAYMENT-REQUIRED");
  const requirement = ctx.shielded.parse402Response(first).requirement;

  if (requirement.rail === "shielded-usdc") {
    return ctx.shielded.fetchWithShieldedPayment(
      url,
      init,
      ctx.note,
      ctx.witness,
      ctx.payerPkHash,
    );
  }

  return ctx.payNormalX402(first);
}
```

## ERC-8004 discovery (optional)

If enabled, agents can discover capability before first paid call:

1. Query `GET /agent/:did`.
2. Check `supportedRails` for `shielded-usdc`.
3. Route traffic to shielded flow when supported.

Adapter is feature-flagged:

- `ENABLE_ERC8004=true`
- `ERC8004_REGISTRY_URL=<registry base url>`

Reference:

- `/shielded-402/packages/erc8004-adapter/src/index.ts`
- `/shielded-402/services/merchant-gateway/src/server.ts`

## Why ERC-8004 is optional

1. Settlement correctness does not depend on registry metadata.
2. The payment decision remains enforced by x402 challenge binding + proof verification + nullifier/root checks.
3. ERC-8004 may be unavailable or evolving (draft), but direct shielded x402 calls must still work.
4. Therefore the adapter is feature-gated and non-blocking.

## How to utilize ERC-8004 exactly

1. Enable in gateway:
   - `ENABLE_ERC8004=true`
   - `ERC8004_REGISTRY_URL=<registry base url>`
2. Merchant publishes/updates capability:
   - `POST /agent` with `AgentRecord` including `supportedRails: ["shielded-usdc"]`.
3. Agent resolves routing metadata:
   - `GET /agent/:did`
   - `GET /agent/:did/reputation` (optional reputation signal)
4. If `supportedRails` contains `shielded-usdc`, route paid calls to this rail.
5. Execute the normal shielded x402 retry flow on the selected endpoint.

## Testing plan for agents

Full step-by-step commands:

- `/shielded-402/docs/testing-playbook.md`

### Level 1: local SDK/unit baseline

Run:

- `pnpm typecheck`
- `pnpm test`
- `pnpm contracts:test`
- `pnpm circuit:check`

Goal: verify local code paths and constraints compile.

### Level 2: local HTTP handshake

1. Start relayer:
   - `pnpm relayer:dev`
2. Start merchant endpoint:
   - `pnpm --filter @shielded-x402/merchant-gateway dev`
3. Run demo client:
   - `pnpm --filter @shielded-x402/demo-api demo`

Goal: verify `402 -> retry -> 200` behavior and header handling.

### Level 3: live Sepolia verification

1. Set `.env` with real addresses and RPC.
2. Generate verifier + fixture:
   - `pnpm circuit:verifier`
   - `pnpm circuit:fixture`
3. Start relayer with onchain verifier + settlement env.
4. Run:
   - `pnpm test:sepolia-live`

Goal: verify root/nullifier checks + proof verification against deployed contracts.

## Hardcoded values you should review

The following are intentional defaults for MVP/dev, but should be explicitly set in production:

1. Placeholder merchant config defaults in gateway:
   - `/shielded-402/services/merchant-gateway/src/server.ts`
   - Fallback `merchantPubKey` and `verifyingContract` are non-production placeholders.
2. Default price:
   - `PRICE_USDC_MICROS` default `1000000` (1 USDC) in gateway and `.env.example`.
3. Fixed rail name:
   - Type-level rail is currently `'shielded-usdc'` in `/shielded-402/packages/shared-types/src/types.ts`.
4. Challenge domain hash constants:
   - `/shielded-402/sdk/client/src/crypto.ts`
   - `/shielded-402/sdk/merchant/src/merchant.ts`
   - `/shielded-402/circuits/spend_change/src/main.nr`
   - These must remain identical across circuit/client/merchant.
5. Merkle depth constant:
   - Circuit path depth and contract tree depth are fixed to `24`.
6. Dev-only deterministic nonce:
   - `FIXED_CHALLENGE_NONCE` should be set only for deterministic tests.
7. Demo private key:
   - `/shielded-402/examples/demo-api/src/run-demo.ts` uses a hardcoded key for local demo only.
8. Chain/RPC selection:
   - Onchain verifier client uses the configured RPC endpoint. Ensure your `SEPOLIA_RPC_URL` (or local RPC) points to the same network where pool/verifier are deployed.

## Production checklist for agent operators

1. Set all env values; do not rely on fallbacks.
2. Disable `FIXED_CHALLENGE_NONCE`.
3. Use real signer keys and secure key storage.
4. Keep challenge TTL short and monitor replay failures.
5. Keep proof verifier and circuit artifacts in sync per deployment.
6. If enabling ERC-8004, treat it as discovery/routing only (not settlement correctness).
