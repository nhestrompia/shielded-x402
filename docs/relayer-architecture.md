# Relayer Architecture (v1)

Each relayer instance is chain-scoped (`RELAYER_CHAIN_REF`) and only exposes:

- `POST /v1/relay/pay`

Relayer responsibilities:

1. Validate request shape.
2. Verify sequencer authorization signature and chainRef.
3. Execute settlement action for its chain.
4. Submit signed execution report to sequencer.

Relayers no longer expose `/v1/relay/credit/*` endpoints.
