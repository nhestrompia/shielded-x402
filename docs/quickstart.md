# Quickstart

## 1) Install and validate

- `pnpm install`
- `pnpm contracts:deps`
- `pnpm doctor`

`pnpm doctor` checks `node`, `pnpm`, `forge`, `nargo`, `bb`, and Solady presence.

## 2) Build and test

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm contracts:test`

## 3) Circuit checks and verifier generation

- `pnpm circuit:check`
- `pnpm circuit:verifier`
- `pnpm circuit:fixture` (generates `ops/fixtures/sepolia-payment-response.json` from bb proof output)

Verifier output target:

- `contracts/generated/UltraVerifier.sol`

## 4) Deploy to Sepolia

- `cp .env.example .env`
- Set `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `USDC_ADDRESS`
- Run `pnpm deploy:sepolia`

Deployment script outputs:

- UltraVerifier address
- NoirVerifierAdapter address
- ShieldedPool address

## 5) Run merchant gateway

- `pnpm --filter @shielded-x402/merchant-gateway dev`

Gateway endpoints:

- `GET /health`
- `GET /paid/data` (shielded x402 protected)
- `POST /merchant/withdraw/sign` (withdrawal auth signing)

## 6) Run live Sepolia E2E

- Provide a valid proof fixture JSON via `E2E_PAYMENT_RESPONSE_FILE`
- Set `FIXED_CHALLENGE_NONCE` to the nonce the fixture proof was generated against
- Run: `pnpm test:sepolia-live`

## 7) Local Anvil dummy deployment

- Start anvil: `anvil --chain-id 31337`
- Deploy local stack: `pnpm deploy:anvil:dummy`
- Use printed addresses to configure gateway env for local integration.
- Run full automated local smoke test: `pnpm e2e:anvil`

For full command sequences, see:

- `/shielded-402/docs/testing-playbook.md`
