import express from 'express';
import {
  RELAYER_ROUTES,
  type RelayerChallengeRequest,
  type RelayerPayRequest
} from '@shielded-x402/shared-types';
import { createChallengeFetcher } from './challenge.js';
import { createShieldedChallengeBridge } from './bridge.js';
import { createPaymentRelayerProcessor } from './processor.js';
import {
  createForwardPayoutAdapter,
  createNoopPayoutAdapter,
  createX402PayoutAdapter
} from './payout.js';
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
const relayerX402RpcUrl = process.env.RELAYER_X402_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL;
const relayerX402PrivateKey =
  (process.env.RELAYER_X402_PRIVATE_KEY as `0x${string}` | undefined) ?? relayerPrivateKey;
const relayerX402Chain = (process.env.RELAYER_X402_CHAIN ?? 'base-sepolia') as
  | 'base-sepolia'
  | 'sepolia';
const relayerChallengeTtlMs = Number(process.env.RELAYER_CHALLENGE_TTL_MS ?? '180000');
const relayerShieldedMerchantPubKey = (process.env.RELAYER_SHIELDED_MERCHANT_PUBKEY ??
  process.env.MERCHANT_PUBKEY ??
  '0x1111111111111111111111111111111111111111111111111111111111111111') as `0x${string}`;
const relayerShieldedVerifyingContract = (process.env.RELAYER_SHIELDED_VERIFYING_CONTRACT ??
  shieldedPoolAddress ??
  '0x2222222222222222222222222222222222222222') as `0x${string}`;

const challengeFetcher = createChallengeFetcher();
const challengeBridge = createShieldedChallengeBridge({
  challengeFetcher,
  challengeTtlMs: relayerChallengeTtlMs,
  merchantPubKey: relayerShieldedMerchantPubKey,
  verifyingContract: relayerShieldedVerifyingContract
});

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
    : payoutMode === 'x402'
      ? (() => {
          if (!relayerX402RpcUrl || !relayerX402PrivateKey) {
            throw new Error(
              'RELAYER_PAYOUT_MODE=x402 requires RELAYER_X402_RPC_URL(or BASE_SEPOLIA_RPC_URL) and RELAYER_X402_PRIVATE_KEY(or RELAYER_PRIVATE_KEY)'
            );
          }
          return createX402PayoutAdapter({
            rpcUrl: relayerX402RpcUrl,
            privateKey: relayerX402PrivateKey,
            chain: relayerX402Chain,
            staticHeaders: staticPayoutHeaders
          });
        })()
      : createForwardPayoutAdapter({
          staticHeaders: staticPayoutHeaders
        });

const processor = createPaymentRelayerProcessor({
  store: new FileSettlementStore(storePath),
  verifier,
  settlement,
  payout,
  challengeFetcher
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    onchainVerifierEnabled: Boolean(rpcUrl && shieldedPoolAddress && ultraVerifierAddress),
    onchainSettlementEnabled: Boolean(rpcUrl && shieldedPoolAddress && relayerPrivateKey),
    payoutMode,
    x402PayoutEnabled: payoutMode === 'x402',
    challengeBridgeEnabled: true,
    storePath
  });
});

app.post(RELAYER_ROUTES.challenge, async (req, res) => {
  try {
    const challengeRequest = req.body as RelayerChallengeRequest;
    const issued = await challengeBridge.issueChallenge(challengeRequest);
    res.setHeader('Cache-Control', 'no-store');
    res.json(issued);
  } catch (error) {
    res.status(400).json({
      error: 'failed to issue shielded challenge',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
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
