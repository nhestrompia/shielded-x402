# Changelog

All notable changes to this project are documented in this file.

## 0.2.0 - 2026-02-15

### Added
- Strict x402 v2 wire envelope helpers in shared types.
- Explicit agent deposit prerequisite docs for shielded settlement.
- `LICENSE` file (MIT).

### Changed
- Switched to strict header flow:
  - Challenge: `PAYMENT-REQUIRED`
  - Retry: `PAYMENT-SIGNATURE`
  - Removed request-side legacy use of `PAYMENT-RESPONSE`.
- Removed legacy fallback parsing/headers across client, merchant, relayer, and gateway.
- Bumped npm package versions:
  - `@shielded-x402/shared-types` -> `0.2.0`
  - `@shielded-x402/client` -> `0.2.0`
- Updated docs to match strict v2-only flow.

### Fixed
- Full workspace typecheck and tests passing after strict v2 migration.
- CI Noir toolchain pin aligned with client peer dependency expectations.
