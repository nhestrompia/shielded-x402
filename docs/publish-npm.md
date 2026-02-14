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

pnpm --filter @shielded-x402/shared-types publish --access public --no-git-checks
pnpm --filter @shielded-x402/client publish --access public --no-git-checks
```

## Version Bump

Bump versions before publishing:

```bash
pnpm --filter @shielded-x402/shared-types version <new-version>
pnpm --filter @shielded-x402/client version <new-version>
```

Then run `pnpm install` to refresh workspace lockfile.

## Consumer Install

```bash
pnpm add @shielded-x402/client @noir-lang/noir_js @aztec/bb.js
```

Then in app code:

```ts
import {
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createShieldedFetch
} from '@shielded-x402/client';
```
