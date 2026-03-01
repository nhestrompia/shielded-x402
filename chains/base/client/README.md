# Base Relayer Adapter (MVP)

Relayer-side helper for Base/EVM payout mode.

## Export

1. `submitEvmNativeTransfer`

## Input

1. `rpcUrl`
2. `privateKey`
3. `recipient`
4. `amountWei`
5. `chainId` (optional)

## Output

1. Confirmed EVM transaction hash (`txHash`) for sequencer execution reporting.
