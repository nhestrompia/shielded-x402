# Changelog

All notable changes to this project are documented in this file.

## 0.3.0 - 2026-02-16

### Changed

- Privacy hardening: SDK payment APIs now require an explicit `nullifierSecret` and no longer use `payerPkHash` naming in context or method signatures.
- `FileBackedWalletState` now persists note-specific `nullifierSecret` values and returns spend context directly from stored note secrets.
- Relayer settlement handling now carries `changeNullifierSecret` so change notes are immediately reusable without external secret derivation.
- Updated SDK docs and examples to use `NULLIFIER_SECRET` and note-specific secret persistence.

### Breaking

- `wallet-state.json` schema version bumped to `2`.
- Existing version `1` wallet state files are intentionally unsupported and must be recreated/reseeded.

### Fixed

- Client unit tests now use explicit independent nullifier-secret fixtures instead of reusing `note.pkHash` for demonstration cases.

## 0.2.4 - 2026-02-16

### Fixed

- Relayer payout provider bridge now correctly handles provider-specific x402 header/network transformations while preserving normalized x402 requirement semantics.
- Added fallback parsing for 402 JSON bodies that omit the `PAYMENT-REQUIRED` header in both relayed client flow and relayer challenge fetcher.
- Improved hosted x402 provider adapter matching and safer optional context typing under `exactOptionalPropertyTypes`.
- Tightened `relayerFetch` test typings for stricter TypeScript checks.
- Bumped package versions:
  - `@shielded-x402/shared-types` -> `0.2.4`
  - `@shielded-x402/client` -> `0.2.4`

## 0.2.2 - 2026-02-15

### Fixed

- `@shielded-x402/client` build now always refreshes `dist/circuits/spend_change.json` from `src/circuits/spend_change.json`.
- Prevents stale published circuit ABI (32-depth) from drifting against current runtime Merkle depth (24).
- Package build now cleans `dist` before emit for deterministic publish artifacts.
- Bumped package versions:
  - `@shielded-x402/shared-types` -> `0.2.2`
  - `@shielded-x402/client` -> `0.2.2`

## 0.2.1 - 2026-02-15

### Fixed

- Published `@shielded-x402/shared-types` now includes relayer bridge surface:
  - `parsePaymentRequiredEnvelope`
  - `RELAYER_ROUTES.challenge`
  - `RelayerChallengeRequest` / `RelayerChallengeResponse`
  - binary-safe relay payload fields (`bodyBase64`)
- `@shielded-x402/client` now depends on `@shielded-x402/shared-types` via `workspace:^0.2.1` for correct monorepo linking and publish-time semver resolution.
- `sdk/client` TypeScript config now resolves workspace shared-types APIs correctly during local builds.
