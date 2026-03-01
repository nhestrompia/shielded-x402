# Agents Guide

Agents should use sequencer-backed authorizations rather than legacy credit channel routes.

Core flow:

1. Build/sign `IntentV1`.
2. Submit to sequencer `POST /v1/credit/authorize`.
3. Submit returned authorization to chain relayer `POST /v1/relay/pay`.
4. Use commitment proof endpoint for delayed audit evidence.

Canonical spec: [`docs/multi-chain-credit-mvp.md`](./multi-chain-credit-mvp.md)
