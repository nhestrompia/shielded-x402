# Toolchain Pins

- Node: `24.x`
- pnpm: `10.x`
- Foundry: `1.5.1`
- Noir toolchain:
  - `nargo`: `1.0.0-beta.18`
  - `noirc`: `1.0.0-beta.18`
  - `bb` (CLI): `3.0.0-nightly.20260102` (installed via `bbup -nv 1.0.0-beta.18`)
- SDK proving libs:
  - `@noir-lang/noir_js`: `1.0.0-beta.18`
  - `@aztec/bb.js`: use the tested compatible nightly tuple with Noir `1.0.0-beta.18`
- UltraHonk oracle hash mode: `keccak` (default for verifier generation + SDK provider)
- Solady (Foundry dependency): `Vectorized/solady`

## Install Notes

- Noir docs: https://noir-lang.org/docs/
- Install Noir CLI: `noirup`
- Install Barretenberg CLI: `bbup`
- Install pinned tuple:
  - `noirup -v 1.0.0-beta.18`
  - `PATH="$HOME/.nargo/bin:$PATH" ~/.bb/bbup -nv 1.0.0-beta.18`
- Ensure both are on PATH (or use defaults: `~/.nargo/bin/nargo` and `~/.bb/bb`)
- Install Solady with `pnpm contracts:deps`.
- Run `pnpm doctor` to validate local toolchain.

## Why strict pinning?

Noir/Barretenberg combinations are compatibility tuples. Mixing versions across:
- verifier generation (`bb` CLI),
- in-process proving (`@aztec/bb.js`, `@noir-lang/noir_js`),
- and circuit compilation (`nargo`),

can produce proofs that fail onchain verification even when witness generation succeeds.
