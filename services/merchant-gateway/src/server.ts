import express from 'express';
import { randomUUID } from 'node:crypto';
import { ShieldedMerchantSDK } from '@shielded-x402/merchant';
import { X402_HEADERS } from '@shielded-x402/shared-types';
import type { Erc8004AdapterConfig } from '@shielded-x402/erc8004-adapter';
import type { MerchantConfig, MerchantHooks, WithdrawRequest } from '@shielded-x402/merchant';
import { Erc8004Adapter } from '@shielded-x402/erc8004-adapter';
import { createShieldedPaymentMiddleware } from './middleware/shieldedPayment.js';
import { createAllowAllVerifier, createOnchainVerifier } from './lib/verifier.js';
import { createNoopSettlement, createOnchainSettlement } from './lib/settlement.js';

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

const rpcUrl = process.env.SEPOLIA_RPC_URL;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS as `0x${string}` | undefined;
const ultraVerifierAddress = process.env.ULTRA_VERIFIER_ADDRESS as `0x${string}` | undefined;
const paymentVerifyingContract = process.env.PAYMENT_VERIFYING_CONTRACT as `0x${string}` | undefined;
const paymentRelayerPrivateKey = process.env.PAYMENT_RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
const unsafeDevMode = parseBoolean(process.env.GATEWAY_UNSAFE_DEV_MODE, false);
const registryUrl = process.env.ERC8004_REGISTRY_URL;
const fixedChallengeNonce = process.env.FIXED_CHALLENGE_NONCE as `0x${string}` | undefined;

const erc8004Enabled = process.env.ENABLE_ERC8004 === 'true';
const erc8004Config: Erc8004AdapterConfig = { enabled: erc8004Enabled };
if (registryUrl) {
  erc8004Config.registryUrl = registryUrl;
}
const erc8004 = new Erc8004Adapter(erc8004Config);

if (!unsafeDevMode) {
  const missingVerifierEnv: string[] = [];
  if (!rpcUrl) missingVerifierEnv.push('SEPOLIA_RPC_URL');
  if (!shieldedPoolAddress) missingVerifierEnv.push('SHIELDED_POOL_ADDRESS');
  if (!ultraVerifierAddress) missingVerifierEnv.push('ULTRA_VERIFIER_ADDRESS');
  if (missingVerifierEnv.length > 0) {
    throw new Error(
      `Missing required verifier env: ${missingVerifierEnv.join(', ')}. Set GATEWAY_UNSAFE_DEV_MODE=true only for local insecure testing.`
    );
  }
  if (!paymentRelayerPrivateKey) {
    throw new Error(
      'PAYMENT_RELAYER_PRIVATE_KEY is required for onchain settlement confirmation. Set GATEWAY_UNSAFE_DEV_MODE=true only for local insecure testing.'
    );
  }
}
if (unsafeDevMode) {
  console.warn(
    '[merchant-gateway] GATEWAY_UNSAFE_DEV_MODE=true -> running with insecure fallback adapters when onchain config is missing.'
  );
}

const verifier =
  !unsafeDevMode
    ? createOnchainVerifier({
        rpcUrl: rpcUrl!,
        shieldedPoolAddress: shieldedPoolAddress!,
        ultraVerifierAddress: ultraVerifierAddress!,
      })
    : rpcUrl && shieldedPoolAddress && ultraVerifierAddress
    ? createOnchainVerifier({
        rpcUrl,
        shieldedPoolAddress,
        ultraVerifierAddress
      })
    : createAllowAllVerifier();

const settlement =
  !unsafeDevMode
    ? createOnchainSettlement({
        rpcUrl: rpcUrl!,
        shieldedPoolAddress: shieldedPoolAddress!,
        relayerPrivateKey: paymentRelayerPrivateKey!,
      })
    : rpcUrl && shieldedPoolAddress && paymentRelayerPrivateKey
    ? createOnchainSettlement({
        rpcUrl,
        shieldedPoolAddress,
        relayerPrivateKey: paymentRelayerPrivateKey
      })
    : createNoopSettlement();

const merchantConfig: MerchantConfig = {
  rail: 'shielded-usdc',
  price: BigInt(process.env.PRICE_USDC_MICROS ?? '1000000'),
  merchantPubKey:
    (process.env.MERCHANT_PUBKEY as `0x${string}` | undefined) ??
    '0x1111111111111111111111111111111111111111111111111111111111111111',
  verifyingContract:
    paymentVerifyingContract ??
    (process.env.SHIELDED_POOL_ADDRESS as `0x${string}` | undefined) ??
    '0x2222222222222222222222222222222222222222',
  challengeTtlMs: Number(process.env.CHALLENGE_TTL_MS ?? '180000')
};
if (fixedChallengeNonce) {
  merchantConfig.fixedChallengeNonce = fixedChallengeNonce;
}

const merchantHooks: MerchantHooks = {
  verifyProof: verifier.verifyProof,
  isNullifierUsed: verifier.isNullifierUsed
};

const sdk = new ShieldedMerchantSDK(merchantConfig, merchantHooks);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    unsafeDevMode,
    erc8004Enabled,
    onchainVerifierEnabled: Boolean(rpcUrl && shieldedPoolAddress && ultraVerifierAddress),
    onchainSettlementEnabled: Boolean(rpcUrl && shieldedPoolAddress && paymentRelayerPrivateKey)
  });
});

app.get('/x402/requirement', (_req, res) => {
  const challenge = sdk.issue402();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(X402_HEADERS.paymentRequired, challenge.headerValue);
  res.status(200).json({
    requirement: challenge.requirement
  });
});

app.get('/agent/:did', async (req, res) => {
  const record = await erc8004.resolveAgent(req.params.did);
  if (!record) {
    res.status(404).json({ error: 'agent not found or adapter disabled' });
    return;
  }
  res.json(record);
});

app.get('/agent/:did/reputation', async (req, res) => {
  const reputation = await erc8004.getReputation(req.params.did);
  if (!reputation) {
    res.status(404).json({ error: 'reputation not found or adapter disabled' });
    return;
  }
  res.json(reputation);
});

app.post('/agent', async (req, res) => {
  try {
    await erc8004.publishRailCapability(req.body);
    res.status(202).json({ accepted: true });
  } catch (error) {
    res.status(400).json({
      error: 'failed to publish agent capability',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/paid/data', createShieldedPaymentMiddleware({ sdk, verifier, settlement }), (_req, res) => {
  res.json({
    ok: true,
    data: {
      modelHint: 'private-inference-token',
      requestId: randomUUID()
    }
  });
});

app.post('/merchant/withdraw/sign', async (req, res) => {
  try {
    const withdrawRequest: WithdrawRequest = {
      nullifier: req.body.nullifier,
      challengeNonce: req.body.challengeNonce,
      recipient: req.body.recipient
    };
    const payload = await sdk.decryptAndWithdraw(withdrawRequest);
    res.json(payload);
  } catch (error) {
    res.status(400).json({
      error: 'invalid withdrawal request',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`merchant-gateway listening on ${port}`);
});
