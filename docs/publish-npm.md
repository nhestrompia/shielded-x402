# npm Publish Guide

This repo can be consumed directly from GitHub, but npm is the right path for plug-and-play agent adoption.

## Packages to Publish

Publish in this order:

1. `@shielded-x402/shared-types`
2. `@shielded-x402/client`

`@shielded-x402/client` depends on `@shielded-x402/shared-types` and bundles the default Noir circuit artifact.

## Pre-publish Validation

From repo root:

```bash
pnpm typecheck
pnpm test
pnpm e2e:anvil
pnpm --filter @shielded-x402/shared-types pack
pnpm --filter @shielded-x402/client pack
```

## Publish Commands

```bash
npm login

pnpm publish:packages
```

This command:

1. builds `@shielded-x402/shared-types` and `@shielded-x402/client`
2. packs both with `pnpm pack` (workspace deps are rewritten to semver)
3. publishes tarballs with `npm publish <tarball>`

Dry-run:

```bash
pnpm publish:packages:dry-run
```

Optional env overrides:

```bash
NPM_TAG=next pnpm publish:packages
NPM_ACCESS=public pnpm publish:packages
NPM_CACHE_DIR=/tmp/shielded-x402-npm-cache pnpm publish:packages
```

If npm throws cache permission errors (`EPERM` under `~/.npm/_cacache`), fix once:

```bash
sudo chown -R "$(id -u):$(id -g)" ~/.npm
```

## Version Bump

Bump versions before publishing:

```bash
cd packages/shared-types && npm version <new-version> --no-git-tag-version
cd ../../sdk/client && npm version <new-version> --no-git-tag-version
```

Then run `pnpm install` to refresh workspace lockfile.

If this release contains wire-format breaking changes, bump minor/major (for example `0.2.0`).

## Consumer Install

```bash
pnpm add @shielded-x402/client @noir-lang/noir_js @aztec/bb.js
```

Then in app code:

```ts
import {
  ShieldedClientSDK,
  createCreditChannelClient,
  createCreditShieldedFetch,
  createNoirJsProofProviderFromDefaultCircuit
} from '@shielded-x402/client';
```
