# Delivery Roadmap

## v0

- Monorepo scaffold with Foundry + TypeScript + Noir layout.
- ShieldedPool contract with deposit, submitSpend, root history, nullifier registry.
- Noir spend/change circuit scaffold.
- Merchant gateway middleware with strict x402 v2 headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`).
- Client SDK implementing `deposit`, `buildSpendProof`, `pay402`, `fetchWithShieldedPayment`.

## v1 (implemented)

- Replaced mock deployment target with generated Noir verifier deployment flow (`UltraVerifier` + `NoirVerifierAdapter`).
- Implemented production note encryption utilities (ECDH + HKDF + AES-256-GCM envelope).
- Implemented merchant withdrawal signing service (`/merchant/withdraw/sign`) and SDK signing hooks.
- Added Sepolia deployment + live integration harness (`pnpm test:sepolia-live`) and canary workflow integration.
- Enabled ERC-8004 registry adapter behind feature flag (`ENABLE_ERC8004`).
