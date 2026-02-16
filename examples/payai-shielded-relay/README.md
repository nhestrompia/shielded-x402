# PayAI via Shielded Relayer (Hybrid)

This example demonstrates:

1. agent calls existing x402 merchant endpoint directly
2. relayed shielded fetch auto-bridges merchant `402` to relayer shielded challenge
3. agent generates local shielded proof (`shielded-usdc`)
4. relayer settles on your shielded pool onchain
5. relayer pays upstream merchant endpoint via standard x402 (`x402-fetch`)
6. relayer returns merchant response bytes to the agent
7. SDK writes relayer settlement deltas back to `wallet-state.json` automatically

Requires `@shielded-x402/client` with `FileBackedWalletState` (next publish after `0.2.2`).

Target merchant URL:

- `https://x402.payai.network/api/base-sepolia/paid-content`

## Important

This is the plug-and-play path for existing x402 merchants. It requires:

- your own relayer configured with `RELAYER_PAYOUT_MODE=x402`
- relayer x402 payout key funded on the upstream chain (Base Sepolia for PayAI endpoint)

## Run

```bash
cd shielded-402
pnpm --filter @shielded-x402/shared-types build
pnpm --filter @shielded-x402/client build

cd shielded-402/examples/payai-shielded-relay
npm install
cp .env.example .env
# set PAYER_PRIVATE_KEY and NOTE_* values
npm run start
```

## Environment

- `RELAYER_ENDPOINT` (default `http://127.0.0.1:3100`)
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
- `PAYER_PK_HASH` (nullifier secret used in this MVP)

The script now uses SDK `FileBackedWalletState`:

- stores note secrets + commitments in `WALLET_STATE_PATH`
- stores `lastSyncedBlock` cursor
- syncs only new blocks each run (incremental)
- supports Envio GraphQL sync (`WALLET_INDEXER_URL`) to avoid RPC log range limits
- derives witness locally from persisted state
- applies relayer settlement deltas (change note + leaf indexes) after each call
- marks spent input notes locally to avoid nullifier reuse on the next run

This is the production-friendly DX path for agents and avoids repeated full-range scans.

Recommended usage:

1. First bootstrap run:
   - set `WALLET_SYNC_ON_START=true`
   - set `POOL_FROM_BLOCK` to your pool deployment block
   - if using Envio hosted, set `WALLET_INDEXER_URL=https://indexer.dev.hyperindex.xyz/<slug>/v1/graphql`
   - run script once to populate `wallet-state.json`
2. Subsequent runs:
   - set `WALLET_SYNC_ON_START=false`
   - script auto-selects an unspent note from `wallet-state.json` (minimal RPC/indexer reads)
   - optionally set `NOTE_COMMITMENT` to pin a specific note

## Nullifier reuse

If you see `failureReason: "nullifier already used"`:

1. The note was already consumed onchain in a previous successful settlement.
2. Re-running with the same note commitment creates the same nullifier and is rejected.

The updated script now marks the spent note in `wallet-state.json` and picks the next unspent note automatically.
If no unspent note remains, deposit a fresh note and retry.

## Seed matching note on pool (required)

Before running the script, deposit the exact note commitment derived from `NOTE_AMOUNT`, `NOTE_RHO`, `NOTE_PK_HASH` to your deployed Sepolia `SHIELDED_POOL_ADDRESS`.

Example:

```bash
cd shielded-402
set -a; source .env; set +a
cd examples/payai-shielded-relay
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

Without `x402` payout mode, relayer forward mode will just proxy request and upstream paid endpoint will return `402`.
