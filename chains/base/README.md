# x402 Base Integration (MVP)

This directory contains Base-side relayer adapter code for onchain payout mode.

- `client/adapter.ts`: minimal EVM native transfer helper used by payment relayer `RELAYER_PAYOUT_MODE=evm`.

## Scope

1. Supports native asset transfer (`sendTransaction`).
2. Returns real EVM tx hash for sequencer execution reporting.
3. Intended for Base Sepolia/Base flows in the multi-chain MVP example.

## Runtime

Used indirectly by `services/payment-relayer` when:

1. `RELAYER_PAYOUT_MODE=evm`
2. `merchantRequest.bodyBase64` contains EVM payload fields (`rpcUrl`, `recipient`, `amountWei`, optional `chainId`)
