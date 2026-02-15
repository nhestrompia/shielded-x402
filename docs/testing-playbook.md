# Testing Playbook (Anvil + Sepolia + Agent Integration)

## 1) Baseline checks (always run first)

1. `pnpm install`
2. `pnpm doctor`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm contracts:test`
6. `pnpm circuit:check`
7. `pnpm circuit:verifier`
8. `pnpm circuit:fixture`

If step 8 succeeds, `ops/fixtures/sepolia-payment-response.json` is fresh and usable for gateway E2E tests.

## 2) Local Anvil flow (dummy contracts + gateway)

### Start local chain

1. Start Anvil in terminal A:
   - `anvil --chain-id 31337`

### Deploy dummy local stack

2. In terminal B:
   - `pnpm deploy:anvil:dummy`

This deploys:
- `MockUSDC`
- `MockProofVerifier`
- `ShieldedPool`
- `DummyShieldedService`

Save the printed addresses.

### Run gateway against Anvil

3. Export env (replace values from deployment output):
   - `export SEPOLIA_RPC_URL=http://127.0.0.1:8545`
   - `export SHIELDED_POOL_ADDRESS=<pool>`
   - `export ULTRA_VERIFIER_ADDRESS=<mock verifier>`
   - `export PAYMENT_RELAYER_PRIVATE_KEY=<funded key on this chain>`
   - `export FIXED_CHALLENGE_NONCE=0x9999999999999999999999999999999999999999999999999999999999999999`
   - `export CHALLENGE_TTL_MS=240000` (recommended when using local NoirJS proving)
   - optional fixture binding: `export PAYMENT_VERIFYING_CONTRACT=0x0000000000000000000000000000000000000002`

4. Start gateway:
   - `pnpm --filter @shielded-x402/merchant-gateway dev`

### Run local paid request flow

5. In terminal C:
   - `pnpm --filter @shielded-x402/demo-api demo`

Expected result:
- First request gets `402`
- Retry with payment headers returns `200`

### Fully automated local smoke test

Run one command:
- `pnpm e2e:anvil`

This command will:
1. start Anvil
2. regenerate fixture
3. deploy mock verifier + pool + dummy service
4. seed pool with the fixture commitment root
5. start gateway against Anvil
6. run `test:anvil-live`

## 3) Sepolia flow (real verifier + pool)

1. `cp .env.example .env`
2. Set required env:
   - `SEPOLIA_RPC_URL`
   - `DEPLOYER_PRIVATE_KEY`
   - `USDC_ADDRESS`
3. Generate verifier:
   - `pnpm circuit:verifier`
4. Deploy verifier + adapter + pool:
   - `pnpm deploy:sepolia`
5. Set gateway env:
   - `SHIELDED_POOL_ADDRESS=<deployed pool>`
   - `ULTRA_VERIFIER_ADDRESS=<deployed ultra verifier>`
   - `PAYMENT_RELAYER_PRIVATE_KEY=<funded key>`
   - `FIXED_CHALLENGE_NONCE=<same nonce used by fixture>`
6. Start gateway:
   - `pnpm --filter @shielded-x402/merchant-gateway dev`
7. Run live gateway E2E:
   - `pnpm test:sepolia-live`

## 4) Dummy onchain merchant service test

You can also deploy a merchant-side service that grants credits only after pool nullifier settlement:

- Deploy to Sepolia:
  - `pnpm deploy:sepolia:dummy-service`
- Optional relayer lock:
  - set `DUMMY_RELAYER_ADDRESS` before deploy, or call `setRelayer(address)` later.

Contract:
- `contracts/src/mocks/DummyShieldedService.sol`

It provides:
- `settlePayment(nullifier, beneficiary, amount, challengeHash)`
- `consumeCredit(amount)`

Use this to test agent/merchant “post-payment service unlocking” onchain.

## 5) What agents need to use shielded rail

An agent must support:

1. x402-style `402 -> retry` handling.
2. Parsing `PAYMENT-REQUIRED` (base64 x402 v2 envelope).
3. Sending retry header:
   - `PAYMENT-SIGNATURE` (base64 signed payment envelope)
4. Maintaining note + Merkle witness state (or delegating to your SDK wrapper).
5. Generating/signing shielded payload via client SDK.

Recommended integration pattern:

1. Try request normally.
2. If no `402`, return.
3. Parse challenge.
4. If `rail === "shielded-usdc"`, run shielded path.
5. Else route to your normal non-shielded rail.

See:
- `docs/agents-guide.md`
- `sdk/client/src/client.ts`
- `packages/shared-types/src/x402.ts`

## 6) Failure tests to run before production

1. Replay same `PAYMENT-SIGNATURE` and ensure reject.
2. Reuse nullifier and ensure reject.
3. Tamper `challengeHash` and ensure reject.
4. Use stale/unknown root and ensure reject.
5. Submit malformed headers and ensure consistent 4xx errors.

## 7) Payment Relayer flow (no merchant change)

1. Start relayer:
   - `RELAYER_RPC_URL=http://127.0.0.1:8545 SHIELDED_POOL_ADDRESS=<pool> ULTRA_VERIFIER_ADDRESS=<verifier> RELAYER_PRIVATE_KEY=<key> pnpm relayer:dev`
2. In agent/client, use `createRelayedShieldedFetch(...)` instead of `createShieldedFetch(...)`.
3. Ensure merchant challenge endpoint is discoverable:
   - provide `challengeUrlResolver`, or ensure paid endpoint returns 402 with `PAYMENT-REQUIRED`.
4. Execute paid request:
   - merchant returns 402
   - agent generates proof locally
   - relayer verifies + settles onchain + executes payout adapter
   - response is returned to agent
5. Verify relayer status:
   - `GET /v1/relay/status/:settlementId`
   - status should reach `DONE`
