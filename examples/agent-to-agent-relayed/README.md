# agent-to-agent-relayed

Legacy credit-channel flow scripts were removed.

Use the sequencer-authorized multi-chain flow:

1. sign and submit `IntentV1` to sequencer
2. submit `AuthorizationV1` to chain relayer (`/v1/relay/pay`)
3. use commitment proof endpoints for delayed audit evidence

See `docs/multi-chain-credit-mvp.md` for canonical details.
