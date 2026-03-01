# Multi-Chain Base + Solana Flow Example

This example runs a full sequencer-authorized flow with one agent paying on:

1. Base relayer (`eip155:8453` for local/noop, or `eip155:84532` for Base Sepolia onchain)
2. Solana relayer (`solana:devnet`)

The same sequencer credit balance is reused across both payments.

## Preconditions

1. Sequencer is running with Postgres migrations applied.
2. Base relayer is running (`noop` or `evm` mode).
3. Solana relayer is running in `RELAYER_PAYOUT_MODE=solana`.
4. Solana verifier + gateway are deployed and initialized:
   - `pnpm --dir chains/solana/client install`
   - `bash chains/solana/scripts/deploy-verifier.sh`
   - `bash chains/solana/scripts/deploy-gateway.sh`
   - `pnpm tsx chains/solana/scripts/init-gateway.ts`
5. `chains/solana/circuits/smt_exclusion/target/smt_exclusion.proof` and
   `chains/solana/circuits/smt_exclusion/target/smt_exclusion.pw` exist.

## Environment

Set these before running:

```bash
export SEQUENCER_URL=http://127.0.0.1:3200
export BASE_RELAYER_URL=http://127.0.0.1:3100
export SOLANA_RELAYER_URL=http://127.0.0.1:3101
export SEQUENCER_ADMIN_TOKEN=change-me

export SOLANA_RPC_URL=https://api.devnet.solana.com
export SOLANA_WS_URL=wss://api.devnet.solana.com
export SOLANA_GATEWAY_PROGRAM_ID=<gateway_program_id>
export SOLANA_VERIFIER_PROGRAM_ID=<verifier_program_id>
export SOLANA_STATE_ACCOUNT=<gateway_state_pda>
export SOLANA_PAYER_KEYPAIR_PATH=<path_to_keypair_json>
export SOLANA_RECIPIENT_ADDRESS=<recipient_pubkey>

# Optional:
# export RELAYER_CALLER_AUTH_TOKEN=<token_if_relayers_require_it>
# export BASE_CHAIN_REF=eip155:8453
# export BASE_ONCHAIN=true
# export BASE_RPC_URL=https://sepolia.base.org
# export BASE_RECIPIENT_ADDRESS=<0x_recipient>
# export BASE_PAYMENT_WEI=1000000000000
# export BASE_CHAIN_ID=84532
# export BASE_MERCHANT_URL=https://merchant.base.example/pay
# export SOLANA_MERCHANT_URL=https://merchant.solana.example/pay
# export BASE_AMOUNT_MICROS=1500000
# export SOLANA_AMOUNT_MICROS=2500000
# export SOLANA_PAYMENT_LAMPORTS=1000000
# export RUN_COMMITMENT_EPOCH=true
```

## Run

```bash
pnpm --dir examples/multi-chain-base-solana start
```

Or use the root command:

```bash
pnpm example:multi-chain:base-solana
```

## Notes

1. For local smoke tests, run Base relayer in `RELAYER_PAYOUT_MODE=noop`.
2. For real Base on-chain txs, run Base relayer in `RELAYER_PAYOUT_MODE=evm`, set `RELAYER_EVM_PRIVATE_KEY`, and set `BASE_ONCHAIN=true` for this example.
3. Solana relayer uses real on-chain transaction signatures as `executionTxHash`.
4. If `RUN_COMMITMENT_EPOCH=true`, the example triggers `POST /v1/commitments/run` and fetches inclusion proofs.

## Recommended stack env for this example

```bash
# base noop + solana onchain (fast local validation)
export RELAYER_BASE_CHAIN_REF=eip155:8453
export RELAYER_BASE_PAYOUT_MODE=noop

# base onchain + solana onchain
# export RELAYER_BASE_CHAIN_REF=eip155:84532
# export RELAYER_BASE_PAYOUT_MODE=evm
# export RELAYER_EVM_PRIVATE_KEY=0x...
```
