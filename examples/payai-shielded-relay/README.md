# PayAI via Credit Channel Relayer

This example demonstrates:

1. one proof-backed credit topup when no local co-signed credit state exists
2. signature-only debit on each API call (`/v1/relay/credit/pay`)
3. relayer pays upstream merchant endpoint via standard x402 (`x402-fetch`)
4. relayer returns merchant response bytes to the agent
5. SDK persists co-signed credit state in `wallet-state.json`

Requires `@shielded-x402/client@^0.3.0` with `FileBackedWalletState` v3.

Target merchant URL:

- `https://x402.payai.network/api/base-sepolia/paid-content`

## Important

This is the credit-lane path for existing x402 merchants. It requires:

- your own relayer configured with `RELAYER_PAYOUT_MODE=x402`
- relayer x402 payout key funded on the upstream chain (Base Sepolia for PayAI endpoint)
- channel id (SDK derives deterministically by default; optional override via `CREDIT_CHANNEL_ID`)

## Run

```bash
cd /path/to/shielded-402
pnpm --filter @shielded-x402/shared-types build
pnpm --filter @shielded-x402/client build

cd examples/payai-shielded-relay
npm install
cp .env.example .env
# set PAYER_PRIVATE_KEY and NOTE_* values
npm run seed-note
npm run start
```

## Environment

- `RELAYER_ENDPOINT` (default `http://127.0.0.1:3100`)
- `CREDIT_RELAYER_ENDPOINT` (optional override for credit routes; defaults to `RELAYER_ENDPOINT`)
- `CREDIT_CHANNEL_ID` (optional bytes32 override; if unset SDK derives one)
- `PAYAI_URL` (default PayAI paid-content endpoint)
- `POOL_RPC_URL` (RPC for the chain where `SHIELDED_POOL_ADDRESS` is deployed)
- `WALLET_INDEXER_URL` (optional Envio GraphQL endpoint for wallet sync, recommended)
- `SHIELDED_POOL_ADDRESS` (pool used for shielded proofs)
- `POOL_FROM_BLOCK` (recommended first sync block; use pool deployment block)
- `WALLET_STATE_PATH` (local persistent file for notes/commitments/sync cursor)
- `WALLET_SYNC_ON_START` (default `false`; set `true` for one-time bootstrap sync)
- `WALLET_SYNC_CHUNK_SIZE` (default `10`; useful for free-tier RPC log range limits)
- `PAYER_PRIVATE_KEY` (agent signer for payment envelope)
- `NOTE_AMOUNT` (must be >= merchant requirement amount)
- `NOTE_RHO`
- `NOTE_PK_HASH`
- `NOTE_COMMITMENT` (optional: force a specific note commitment from wallet state)
- `NULLIFIER_SECRET` (independent secret used to derive note nullifier; must be field-safe)
- `DEPOSITOR_PRIVATE_KEY` (optional; defaults to `DEPLOYER_PRIVATE_KEY` then `PAYER_PRIVATE_KEY`)
- `CREDIT_TOPUP_IF_MISSING` (default `true`)
- `CREDIT_TOPUP_AMOUNT_MICROS` (default `1000000`)
- `CREDIT_TOPUP_CHALLENGE_TTL_SECONDS` (default `600`)
- `CREDIT_NETWORK` (default `eip155:84532`)
- `CREDIT_ASSET` (default zero bytes32 placeholder)
- `CREDIT_PAY_TO` (defaults to `SHIELDED_POOL_ADDRESS`)
- `CREDIT_MERCHANT_PUBKEY` (default `0x11..11`)
- `CREDIT_VERIFYING_CONTRACT` (defaults to `SHIELDED_POOL_ADDRESS`)

The script now uses SDK `FileBackedWalletState`:

- stores note secrets + commitments in `WALLET_STATE_PATH`
- stores `lastSyncedBlock` cursor
- syncs only new blocks each run (incremental)
- supports Envio GraphQL sync (`WALLET_INDEXER_URL`) to avoid RPC log range limits
- derives witness locally from persisted state during topup
- auto-topups once if no credit state exists
- marks spent input notes locally and stores change note secrets after topup

Breaking upgrade note:

- wallet state schema is now `version: 3`
- if upgrading from older SDK builds, recreate or reseed `wallet-state.json`

This is the production-friendly DX path for agents and avoids repeated full-range scans.

Recommended usage:

1. First bootstrap run:
   - set `WALLET_SYNC_ON_START=true`
   - set `POOL_FROM_BLOCK` to your pool deployment block
   - if using Envio hosted, set `WALLET_INDEXER_URL=https://indexer.dev.hyperindex.xyz/c355f9f/v1/graphql` for base-sepolia
   - run script once to populate `wallet-state.json`
2. Subsequent runs:
   - set `WALLET_SYNC_ON_START=false`
   - script reuses stored credit state and performs signature-only debit
   - optionally set `NOTE_COMMITMENT` to pin a specific note

## Nullifier reuse

If you see `failureReason: "nullifier already used"` during topup:

1. The note was already consumed onchain in a previous successful settlement.
2. Re-running with the same note commitment creates the same nullifier and is rejected.

The updated script now marks the spent note in `wallet-state.json` and picks the next unspent note automatically.
If no unspent note remains, deposit a fresh note and retry.

## Why notes are "single-use"

Each shielded note is UTXO-like and can be spent only once (same note => same nullifier).

- one successful topup consumes one input note
- topup settlement creates two outputs:
  - merchant note (for merchant side)
  - change note (back to payer)
- SDK stores change note secrets in `wallet-state.json`, while per-request debit no longer needs proof generation

So you do **not** need to re-deposit for every API call.
You only need a fresh deposit when credit is depleted and there is no spendable note left for a new topup.

## Helper: seed and register a spendable note

Use this helper to avoid manual `cast` commands and lost `NOTE_RHO`:

```bash
cd /path/to/shielded-402/examples/payai-shielded-relay
set -a; source .env; set +a
npm run seed-note
```

It will:

- derive/generate note secrets
- approve + deposit to `SHIELDED_POOL_ADDRESS`
- store the note (with secrets) into `wallet-state.json`
- print `NOTE_*` exports for immediate use

By default it generates a fresh random `NOTE_RHO` and `NULLIFIER_SECRET` each run (safer).
Set `SEED_USE_FIXED_RHO=true` and/or `SEED_USE_FIXED_NULLIFIER_SECRET=true` only if you explicitly want deterministic values.

## Seed matching note on pool (manual fallback)

Before running the script, deposit the exact note commitment derived from `NOTE_AMOUNT`, `NOTE_RHO`, `NOTE_PK_HASH` to your deployed `SHIELDED_POOL_ADDRESS`.
Prefer `npm run seed-note`; manual flow below is fallback.

Example:

```bash
cd /path/to/shielded-402
set -a; source .env; set +a
cd /path/to/shielded-402/examples/payai-shielded-relay
set -a; source .env; set +a

PREIMAGE="0x$(printf '%064x%064x%064x' "$NOTE_AMOUNT" "$NOTE_RHO" "$NOTE_PK_HASH")"
COMMITMENT=$(cast keccak "$PREIMAGE")
DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")

cast send "$USDC_ADDRESS" "mint(address,uint256)" "$DEPLOYER_ADDR" "$NOTE_AMOUNT" \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
cast send "$USDC_ADDRESS" "approve(address,uint256)" "$SHIELDED_POOL_ADDRESS" "$NOTE_AMOUNT" \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
cast send "$SHIELDED_POOL_ADDRESS" "deposit(uint256,bytes32)" "$NOTE_AMOUNT" "$COMMITMENT" \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY"
```

## Relayer config required

In relayer env (`services/payment-relayer`):

- `RELAYER_PAYOUT_MODE=x402`
- `RELAYER_X402_RPC_URL=<base sepolia rpc>`
- `RELAYER_X402_PRIVATE_KEY=<funded key for upstream x402 payment>`
- optional `RELAYER_X402_CHAIN=base-sepolia`
- keep `RELAYER_UNSAFE_DEV_MODE=false` (default fail-closed)

Without `x402` payout mode, relayer forward mode will just proxy request and upstream paid endpoint will return `402`.
