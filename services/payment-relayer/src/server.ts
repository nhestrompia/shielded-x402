import express from 'express';
import { RELAYER_ROUTES, type RelayerPayRequest } from '@shielded-x402/shared-types';
import { createChallengeFetcher } from './challenge.js';
import { createPaymentRelayerProcessor } from './processor.js';
import { createForwardPayoutAdapter, createNoopPayoutAdapter } from './payout.js';
import { createOnchainSettlement, createNoopSettlement } from './settlement.js';
import { FileSettlementStore } from './store.js';
import { createAllowAllVerifier, createOnchainVerifier } from './verifier.js';

function parseStaticHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('RELAYER_PAYOUT_HEADERS_JSON must be an object');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '512kb' }));

const rpcUrl = process.env.RELAYER_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS as `0x${string}` | undefined;
const ultraVerifierAddress = process.env.ULTRA_VERIFIER_ADDRESS as `0x${string}` | undefined;
const relayerPrivateKey =
  (process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined) ??
  (process.env.PAYMENT_RELAYER_PRIVATE_KEY as `0x${string}` | undefined);
const storePath = process.env.RELAYER_STORE_PATH ?? '/tmp/shielded-x402-relayer-store.json';
const payoutMode = process.env.RELAYER_PAYOUT_MODE ?? 'forward';
const staticPayoutHeaders = parseStaticHeaders(process.env.RELAYER_PAYOUT_HEADERS_JSON);

const verifier =
  rpcUrl && shieldedPoolAddress && ultraVerifierAddress
    ? createOnchainVerifier({
        rpcUrl,
        shieldedPoolAddress,
        ultraVerifierAddress
      })
    : createAllowAllVerifier();

const settlement =
  rpcUrl && shieldedPoolAddress && relayerPrivateKey
    ? createOnchainSettlement({
        rpcUrl,
        shieldedPoolAddress,
        relayerPrivateKey
      })
    : createNoopSettlement();

const payout =
  payoutMode === 'noop'
    ? createNoopPayoutAdapter()
    : createForwardPayoutAdapter({
        staticHeaders: staticPayoutHeaders
      });

const processor = createPaymentRelayerProcessor({
  store: new FileSettlementStore(storePath),
  verifier,
  settlement,
  payout,
  challengeFetcher: createChallengeFetcher()
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    onchainVerifierEnabled: Boolean(rpcUrl && shieldedPoolAddress && ultraVerifierAddress),
    onchainSettlementEnabled: Boolean(rpcUrl && shieldedPoolAddress && relayerPrivateKey),
    payoutMode,
    storePath
  });
});

app.post(RELAYER_ROUTES.pay, async (req, res) => {
  try {
    const relayRequest = req.body as RelayerPayRequest;
    const result = await processor.handlePay(relayRequest);
    const httpStatus = result.status === 'DONE' ? 200 : 422;
    res.status(httpStatus).json(result);
  } catch (error) {
    res.status(400).json({
      error: 'invalid relay request',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get(`${RELAYER_ROUTES.statusPrefix}/:settlementId`, async (req, res) => {
  const record = await processor.getStatus(req.params.settlementId);
  if (!record) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(record);
});

const port = Number(process.env.RELAYER_PORT ?? 3100);
app.listen(port, () => {
  console.log(`payment-relayer listening on ${port}`);
});
