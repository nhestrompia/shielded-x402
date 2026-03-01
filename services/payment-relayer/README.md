# Payment Relayer (MVP)

Chain-bound relayer for the breaking multi-chain credit MVP.

This runtime only supports:

1. `POST /v1/relay/pay` with a valid sequencer authorization
2. chainRef enforcement per relayer instance
3. execution report callback to the sequencer
4. relayer-signed execution reports (`relayerKeyId` + `reportSig`)

Legacy `/v1/relay/credit/*` routes are removed.

## Run

```bash
pnpm relayer:dev
```

## Env

- `RELAYER_PORT` (default `3100`)
- `RELAYER_CHAIN_REF` (required, CAIP-2; e.g. `eip155:84532` or `solana:devnet`)
- `RELAYER_SEQUENCER_URL` (required, sequencer base URL)
- `RELAYER_SEQUENCER_KEYS_JSON` (required JSON map: `{ "sequencer_key_id": "0x<ed25519-pubkey-32-bytes>" }`)
- `RELAYER_REPORTING_PRIVATE_KEY` (required; 32-byte seed or 64-byte key hex)
- `RELAYER_KEY_ID` (required logical key identifier sent to sequencer)
- `RELAYER_PAYOUT_MODE=forward|noop|solana|evm` (default `forward`)
- `RELAYER_PAYOUT_HEADERS_JSON` (optional JSON object of static outbound headers)
- `RELAYER_ALLOWED_HOSTS` (optional comma-separated allowlist for forward mode)
- `RELAYER_MERCHANT_TIMEOUT_MS` (default `5000`)
- `RELAYER_MAX_RESPONSE_BYTES` (default `1048576`)
- `RELAYER_RATE_LIMIT_PER_MINUTE` (default `180`)
- `RELAYER_CALLER_AUTH_TOKEN` (optional; when set, `/v1/relay/pay` requires `x-relayer-auth-token`)
- `RELAYER_EVM_PRIVATE_KEY` (optional fallback key for `evm` mode)

For `RELAYER_PAYOUT_MODE=solana`, `merchantRequest.bodyBase64` must contain JSON payload fields accepted by `chains/solana/client/adapter.ts`:

- `rpcUrl`
- `wsUrl`
- `gatewayProgramId`
- `verifierProgramId`
- `stateAccount` (gateway state PDA)
- `recipient`
- `amountLamports`
- `authIdHex`
- `authExpiryUnix`
- `proofBase64`
- `publicWitnessBase64`
- `payerKeypairPath`

For `RELAYER_PAYOUT_MODE=evm`, `merchantRequest.bodyBase64` must contain:

- `rpcUrl`
- `recipient` (EVM address)
- `amountWei`
- `chainId` (optional)
- `privateKey` (optional if `RELAYER_EVM_PRIVATE_KEY` is set on relayer)

## Typical modes

1. Base local smoke:
   - `RELAYER_CHAIN_REF=eip155:8453`
   - `RELAYER_PAYOUT_MODE=noop`
2. Base onchain:
   - `RELAYER_CHAIN_REF=eip155:84532`
   - `RELAYER_PAYOUT_MODE=evm`
   - `RELAYER_EVM_PRIVATE_KEY=0x...`
3. Solana onchain:
   - `RELAYER_CHAIN_REF=solana:devnet`
   - `RELAYER_PAYOUT_MODE=solana`

## Endpoints

- `GET /health`
- `GET /health/ready`
- `GET /metrics`
- `POST /v1/relay/pay`
