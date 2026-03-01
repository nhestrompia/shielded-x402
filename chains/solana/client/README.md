# Solana Relayer Adapter (MVP)

Relayer-side helpers for `x402_gateway` instructions:

1. `submitInitializeState`
2. `submitSetSmtRoot`
3. `submitPayAuthorized`

Notes:

- Uses `@solana/kit`.
- `submitPayAuthorized` requires explicit `stateAccount` (no placeholder fallback).
- `submitPayAuthorized` supports `computeUnits` (defaults to `1_000_000`) and prepends a compute-budget instruction.
- Returns confirmed Solana transaction signature for sequencer execution reporting.

Install adapter deps once before use:

```bash
pnpm --dir chains/solana/client install
```
