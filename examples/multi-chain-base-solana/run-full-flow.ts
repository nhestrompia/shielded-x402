import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { MultiChainCreditClient } from '../../sdk/client/src/multiChainCredit.ts';
import {
  canonicalIntentBytes,
  deriveAgentIdFromPubKey,
  deriveMerchantId,
  normalizeHex,
  type AuthorizeRequestV1,
  type Hex,
  type IntentV1,
  type RelayPayRequestV1
} from '../../packages/shared-types/src/index.ts';

const SOLANA_CHAIN_REF = 'solana:devnet';

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function sha256Hex(data: Uint8Array): Hex {
  return (`0x${createHash('sha256').update(data).digest('hex')}`) as Hex;
}

function publicKeyToHex(publicKeyDer: Buffer): Hex {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (!publicKeyDer.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('unexpected Ed25519 SPKI key format');
  }
  const raw = publicKeyDer.subarray(prefix.length);
  if (raw.length !== 32) {
    throw new Error('expected 32-byte Ed25519 public key');
  }
  return normalizeHex(`0x${raw.toString('hex')}`);
}

function signIntent(intent: IntentV1, privateKey: KeyObject): Hex {
  const digest = createHash('sha256').update(canonicalIntentBytes(intent)).digest();
  const signature = sign(null, digest, privateKey);
  return normalizeHex(`0x${signature.toString('hex')}`);
}

function randomHex32(): Hex {
  return sha256Hex(Buffer.from(`${Date.now()}:${Math.random()}`));
}

async function postRelayPay(
  relayerUrl: string,
  payload: RelayPayRequestV1,
  callerToken?: string
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (callerToken) {
    headers['x-relayer-auth-token'] = callerToken;
  }
  const response = await fetch(`${relayerUrl}/v1/relay/pay`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`relay pay failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function maybeRunCommitment(sequencerUrl: string): Promise<void> {
  if (process.env.RUN_COMMITMENT_EPOCH !== 'true') {
    return;
  }
  const response = await fetch(`${sequencerUrl}/v1/commitments/run`, { method: 'POST' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`commitment run failed (${response.status}): ${text}`);
  }
}

async function main(): Promise<void> {
  const sequencerUrl = envRequired('SEQUENCER_URL');
  const baseRelayerUrl = envRequired('BASE_RELAYER_URL');
  const solanaRelayerUrl = envRequired('SOLANA_RELAYER_URL');
  const baseChainRef = process.env.BASE_CHAIN_REF ?? 'eip155:8453';
  const adminToken = envRequired('SEQUENCER_ADMIN_TOKEN');
  const relayerCallerToken = process.env.RELAYER_CALLER_AUTH_TOKEN;

  const baseMerchantUrl = process.env.BASE_MERCHANT_URL ?? 'https://merchant.base.example/pay';
  const baseOnchain = process.env.BASE_ONCHAIN === 'true';
  const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';
  const baseAmountWei = process.env.BASE_PAYMENT_WEI ?? '1000000000000';
  const baseChainId = process.env.BASE_CHAIN_ID ?? '84532';
  const basePrivateKey = process.env.BASE_PRIVATE_KEY?.trim();
  const solanaMerchantUrl = process.env.SOLANA_MERCHANT_URL ?? 'https://merchant.solana.example/pay';
  const now = Math.floor(Date.now() / 1000);

  const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const solanaWsUrl =
    process.env.SOLANA_WS_URL ??
    solanaRpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  const solanaGatewayProgramId = envRequired('SOLANA_GATEWAY_PROGRAM_ID');
  const solanaVerifierProgramId = envRequired('SOLANA_VERIFIER_PROGRAM_ID');
  const solanaStateAccount = envRequired('SOLANA_STATE_ACCOUNT');
  const solanaPayerKeypairPath = envRequired('SOLANA_PAYER_KEYPAIR_PATH');
  const solanaRecipientAddress = envRequired('SOLANA_RECIPIENT_ADDRESS');
  const solanaAmountLamports = BigInt(process.env.SOLANA_PAYMENT_LAMPORTS ?? '1000000');
  const solanaComputeUnits = Number(process.env.SOLANA_COMPUTE_UNITS_LIMIT ?? '1000000');

  const proofPath =
    process.env.SOLANA_PROOF_PATH ??
    'chains/solana/circuits/smt_exclusion/target/smt_exclusion.proof';
  const witnessPath =
    process.env.SOLANA_PUBLIC_WITNESS_PATH ??
    'chains/solana/circuits/smt_exclusion/target/smt_exclusion.pw';
  const proof = fs.readFileSync(proofPath);
  const publicWitness = fs.readFileSync(witnessPath);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const agentPubKey = publicKeyToHex(publicKey.export({ format: 'der', type: 'spki' }));
  const agentId = deriveAgentIdFromPubKey(agentPubKey);

  const baseMerchantId = deriveMerchantId({
    serviceRegistryId: 'demo/base',
    endpointUrl: baseMerchantUrl
  });
  const solanaMerchantId = deriveMerchantId({
    serviceRegistryId: 'demo/solana',
    endpointUrl: solanaMerchantUrl
  });

  const client = new MultiChainCreditClient({
    sequencerUrl,
    relayerUrls: {
      [baseChainRef]: baseRelayerUrl,
      [SOLANA_CHAIN_REF]: solanaRelayerUrl
    },
    sequencerAdminToken: adminToken
  });

  const baseAmountMicros = process.env.BASE_AMOUNT_MICROS ?? '1500000';
  const solanaAmountMicros = process.env.SOLANA_AMOUNT_MICROS ?? '2500000';
  const totalCredit = (BigInt(baseAmountMicros) + BigInt(solanaAmountMicros) + 1_000_000n).toString();

  await client.adminCredit({
    agentId,
    amountMicros: totalCredit
  });

  const baseIntent: IntentV1 = {
    version: 1,
    agentId,
    agentPubKey,
    signatureScheme: 'ed25519-sha256-v1',
    agentNonce: '0',
    amountMicros: baseAmountMicros,
    merchantId: baseMerchantId,
    requiredChainRef: baseChainRef,
    expiresAt: String(now + 300),
    requestId: randomHex32()
  };
  const baseAuthRequest: AuthorizeRequestV1 = {
    intent: baseIntent,
    agentSig: signIntent(baseIntent, privateKey)
  };
  const baseAuth = await client.authorize(baseAuthRequest);

  const baseRelayPayload: RelayPayRequestV1 = {
    authorization: baseAuth.authorization,
    sequencerSig: baseAuth.sequencerSig,
    merchantRequest: {
      url: baseMerchantUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(
        JSON.stringify(
          baseOnchain
            ? {
                rpcUrl: baseRpcUrl,
                recipient: envRequired('BASE_RECIPIENT_ADDRESS'),
                amountWei: baseAmountWei,
                chainId: baseChainId,
                ...(basePrivateKey ? { privateKey: basePrivateKey } : {})
              }
            : { flow: 'base-payment' }
        ),
        'utf8'
      ).toString('base64')
    }
  };
  const baseRelayResult = await postRelayPay(baseRelayerUrl, baseRelayPayload, relayerCallerToken);

  const solanaIntent: IntentV1 = {
    version: 1,
    agentId,
    agentPubKey,
    signatureScheme: 'ed25519-sha256-v1',
    agentNonce: '1',
    amountMicros: solanaAmountMicros,
    merchantId: solanaMerchantId,
    requiredChainRef: SOLANA_CHAIN_REF,
    expiresAt: String(now + 300),
    requestId: randomHex32()
  };
  const solanaAuthRequest: AuthorizeRequestV1 = {
    intent: solanaIntent,
    agentSig: signIntent(solanaIntent, privateKey)
  };
  const solanaAuth = await client.authorize(solanaAuthRequest);

  const solanaRelayPayload: RelayPayRequestV1 = {
    authorization: solanaAuth.authorization,
    sequencerSig: solanaAuth.sequencerSig,
    merchantRequest: {
      url: solanaMerchantUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(
        JSON.stringify({
          rpcUrl: solanaRpcUrl,
          wsUrl: solanaWsUrl,
          gatewayProgramId: solanaGatewayProgramId,
          verifierProgramId: solanaVerifierProgramId,
          stateAccount: solanaStateAccount,
          recipient: solanaRecipientAddress,
          amountLamports: solanaAmountLamports.toString(),
          computeUnits: solanaComputeUnits,
          authIdHex: solanaAuth.authorization.authId,
          authExpiryUnix: solanaAuth.authorization.expiresAt,
          proofBase64: proof.toString('base64'),
          publicWitnessBase64: publicWitness.toString('base64'),
          payerKeypairPath: solanaPayerKeypairPath
        }),
        'utf8'
      ).toString('base64')
    }
  };
  const solanaRelayResult = await postRelayPay(
    solanaRelayerUrl,
    solanaRelayPayload,
    relayerCallerToken
  );

  await maybeRunCommitment(sequencerUrl);

  console.log('\n=== Multi-chain flow complete ===');
  console.log(`agentId: ${agentId}`);
  console.log(`base authId: ${baseAuth.authorization.authId}`);
  console.log(`base relay result: ${JSON.stringify(baseRelayResult, null, 2)}`);
  console.log(`solana authId: ${solanaAuth.authorization.authId}`);
  console.log(`solana relay result: ${JSON.stringify(solanaRelayResult, null, 2)}`);

  if (process.env.RUN_COMMITMENT_EPOCH === 'true') {
    const baseProof = await client.commitmentProof(baseAuth.authorization.authId);
    const solanaProof = await client.commitmentProof(solanaAuth.authorization.authId);
    console.log(`base commitment epoch: ${baseProof.epochId}`);
    console.log(`solana commitment epoch: ${solanaProof.epochId}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
