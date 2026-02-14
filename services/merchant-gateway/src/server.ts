import express from 'express';
import { randomUUID } from 'node:crypto';
import { ShieldedMerchantSDK, createLocalWithdrawalSigner } from '@shielded-x402/merchant';
import type { Erc8004AdapterConfig } from '@shielded-x402/erc8004-adapter';
import type { MerchantConfig, MerchantHooks, WithdrawRequest } from '@shielded-x402/merchant';
import { Erc8004Adapter } from '@shielded-x402/erc8004-adapter';
import { createShieldedPaymentMiddleware } from './middleware/shieldedPayment.js';
import { createAllowAllVerifier, createOnchainVerifier } from './lib/verifier.js';

const rpcUrl = process.env.SEPOLIA_RPC_URL;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS as `0x${string}` | undefined;
const ultraVerifierAddress = process.env.ULTRA_VERIFIER_ADDRESS as `0x${string}` | undefined;
const paymentVerifyingContract = process.env.PAYMENT_VERIFYING_CONTRACT as `0x${string}` | undefined;
const merchantWithdrawPrivateKey = process.env.MERCHANT_WITHDRAW_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const registryUrl = process.env.ERC8004_REGISTRY_URL;
const fixedChallengeNonce = process.env.FIXED_CHALLENGE_NONCE as `0x${string}` | undefined;

const erc8004Enabled = process.env.ENABLE_ERC8004 === 'true';
const erc8004Config: Erc8004AdapterConfig = { enabled: erc8004Enabled };
if (registryUrl) {
  erc8004Config.registryUrl = registryUrl;
}
const erc8004 = new Erc8004Adapter(erc8004Config);

const verifier =
  rpcUrl && shieldedPoolAddress && ultraVerifierAddress
    ? createOnchainVerifier({
        rpcUrl,
        shieldedPoolAddress,
        ultraVerifierAddress
      })
    : createAllowAllVerifier();

const withdrawalSigner = merchantWithdrawPrivateKey
  ? createLocalWithdrawalSigner(merchantWithdrawPrivateKey)
  : undefined;

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
  challengeTtlMs: Number(process.env.CHALLENGE_TTL_MS ?? '60000')
};
if (withdrawalSigner) {
  merchantConfig.merchantSignerAddress = withdrawalSigner.address;
}
if (fixedChallengeNonce) {
  merchantConfig.fixedChallengeNonce = fixedChallengeNonce;
}

const merchantHooks: MerchantHooks = {
  verifyProof: verifier.verifyProof,
  isNullifierUsed: verifier.isNullifierUsed
};
if (withdrawalSigner) {
  merchantHooks.signWithdrawalDigest = withdrawalSigner.signDigest;
}

const sdk = new ShieldedMerchantSDK(merchantConfig, merchantHooks);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    erc8004Enabled,
    onchainVerifierEnabled: Boolean(rpcUrl && shieldedPoolAddress && ultraVerifierAddress),
    withdrawalSignerEnabled: Boolean(withdrawalSigner)
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

app.get('/paid/data', createShieldedPaymentMiddleware({ sdk, verifier }), (_req, res) => {
  res.json({
    ok: true,
    data: {
      modelHint: 'private-inference-token',
      requestId: randomUUID()
    }
  });
});

app.post('/merchant/withdraw/sign', async (req, res) => {
  if (!withdrawalSigner) {
    res.status(501).json({ error: 'withdrawal signer not configured' });
    return;
  }
  try {
    const withdrawRequest: WithdrawRequest = {
      encryptedNote: req.body.encryptedNote,
      recipient: req.body.recipient
    };
    if (req.body.amount) {
      withdrawRequest.amount = BigInt(req.body.amount);
    }
    if (req.body.claimId) {
      withdrawRequest.claimId = req.body.claimId;
    }
    if (req.body.deadline) {
      withdrawRequest.deadline = Number(req.body.deadline);
    }
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
