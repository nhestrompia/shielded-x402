# Toolchain Pins

- Node: `24.x`
- pnpm: `10.x`
- Foundry: `1.5.1`
- Noir toolchain: `noirup` managed (pin in CI via `noirup -v <VERSION>`)
- Nargo: version provided by pinned noirup release
- Barretenberg (`bb`): version provided by pinned noirup release
- Solady (Foundry dependency): `Vectorized/solady`

## Install Notes

- Noir docs: https://noir-lang.org/docs/
- Install Noir CLI: `noirup`
- Install Barretenberg CLI: `bbup`
- Ensure both are on PATH (or use defaults: `~/.nargo/bin/nargo` and `~/.bb/bb`)
- Install Solady with `pnpm contracts:deps`.
- Run `pnpm doctor` to validate local toolchain.
