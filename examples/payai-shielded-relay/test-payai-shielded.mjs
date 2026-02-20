import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  createCreditChannelClient,
  createCreditShieldedFetch,
  FileBackedWalletState,
  ShieldedClientSDK,
  createProofProvider,
  deriveCommitment
} from '@shielded-x402/client';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
// Load only example-local env to avoid root-level leakage between demos.
loadEnv({ path: resolve(here, '.env'), override: true });

const toWord = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const parseEnvBigInt = (key, fallback) => {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  return BigInt(raw);
};
const parseEnvBoolean = (key, fallback) => {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
};
const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const isFieldSafeHex = (value) => {
  try {
    const n = BigInt(value);
    return n >= 0n && n < BN254_FIELD_MODULUS;
  } catch {
    return false;
  }
};

const relayerEndpoint = process.env.RELAYER_ENDPOINT ?? 'http://127.0.0.1:3100';
const creditRelayerEndpoint = process.env.CREDIT_RELAYER_ENDPOINT ?? relayerEndpoint;
const payaiUrl = process.env.PAYAI_URL ?? 'https://x402.payai.network/api/base-sepolia/paid-content';
const poolRpcUrl = process.env.POOL_RPC_URL?.trim() || undefined;
const walletIndexerUrl = process.env.WALLET_INDEXER_URL;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS;
const walletStatePath = process.env.WALLET_STATE_PATH ?? './wallet-state.json';
const poolStartBlock = parseEnvBigInt('POOL_FROM_BLOCK', 0n);
const walletSyncChunkSize = parseEnvBigInt('WALLET_SYNC_CHUNK_SIZE', 10n);
const walletSyncOnStart = parseEnvBoolean('WALLET_SYNC_ON_START', false);
const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
const noteAmount = parseEnvBigInt('NOTE_AMOUNT', 1000000n);
const noteRho = toWord(parseEnvBigInt('NOTE_RHO', 42n));
const notePkHash = toWord(parseEnvBigInt('NOTE_PK_HASH', 11n));
const nullifierSecret = toWord(parseEnvBigInt('NULLIFIER_SECRET', 9n));
const preferredCommitment = process.env.NOTE_COMMITMENT?.trim().toLowerCase();
const configuredChannelId = process.env.CREDIT_CHANNEL_ID?.trim();
const creditTopupIfMissing = parseEnvBoolean('CREDIT_TOPUP_IF_MISSING', true);
const creditTopupAmountMicros = parseEnvBigInt('CREDIT_TOPUP_AMOUNT_MICROS', 1000000n);
const creditTopupChallengeTtlSeconds = Number(process.env.CREDIT_TOPUP_CHALLENGE_TTL_SECONDS ?? '600');
const creditNetwork = process.env.CREDIT_NETWORK ?? 'eip155:84532';
const creditAsset =
  process.env.CREDIT_ASSET ??
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const creditPayTo = process.env.CREDIT_PAY_TO ?? shieldedPoolAddress;
const creditMerchantPubKey =
  process.env.CREDIT_MERCHANT_PUBKEY ??
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const creditVerifyingContract = process.env.CREDIT_VERIFYING_CONTRACT ?? shieldedPoolAddress;

if (!payerPrivateKey || !payerPrivateKey.startsWith('0x')) {
  throw new Error('Set PAYER_PRIVATE_KEY in .env');
}
if (configuredChannelId && !/^0x[0-9a-fA-F]{64}$/.test(configuredChannelId)) {
  throw new Error('If set, CREDIT_CHANNEL_ID must be a bytes32 hex string');
}
if (!poolRpcUrl && !walletIndexerUrl) {
  throw new Error('Set WALLET_INDEXER_URL or POOL_RPC_URL (or SEPOLIA_RPC_URL) in .env');
}
if (!shieldedPoolAddress || !shieldedPoolAddress.startsWith('0x')) {
  throw new Error('Set SHIELDED_POOL_ADDRESS in .env');
}

const account = privateKeyToAccount(payerPrivateKey);
const sdk = new ShieldedClientSDK({
  endpoint: relayerEndpoint,
  signer: (message) => account.signMessage({ message }),
  proofProvider: await createProofProvider({
    backendProofOptions: { verifierTarget: 'evm' }
  })
});

const note = {
  amount: noteAmount,
  rho: noteRho,
  pkHash: notePkHash,
  commitment: deriveCommitment(noteAmount, noteRho, notePkHash),
  leafIndex: -1
};

const walletState = await FileBackedWalletState.create({
  filePath: walletStatePath,
  ...(poolRpcUrl ? { rpcUrl: poolRpcUrl } : {}),
  ...(walletIndexerUrl ? { indexerGraphqlUrl: walletIndexerUrl } : {}),
  shieldedPoolAddress,
  startBlock: poolStartBlock,
  confirmations: 2n,
  chunkSize: walletSyncChunkSize
});

if (isFieldSafeHex(note.rho) && isFieldSafeHex(note.pkHash)) {
  await walletState.addOrUpdateNote(note, nullifierSecret);
} else {
  console.warn(
    `[config-warning] skipping NOTE_* seed note because rho/pkHash is not BN254 field-safe (seedCommitment=${note.commitment})`
  );
}
let syncResult;

const pickSpendableNote = (requiredAmount) => {
  const notes = walletState
    .getNotes()
    .filter(
      (candidate) =>
        candidate.leafIndex >= 0 &&
        !candidate.spent &&
        candidate.amount >= requiredAmount &&
        isFieldSafeHex(candidate.rho) &&
        isFieldSafeHex(candidate.pkHash) &&
        isFieldSafeHex(candidate.nullifierSecret)
    )
    .sort((a, b) => {
      const aBlock = a.depositBlock ?? -1n;
      const bBlock = b.depositBlock ?? -1n;
      if (aBlock !== bBlock) return aBlock > bBlock ? -1 : 1;
      return b.leafIndex - a.leafIndex;
    });

  if (preferredCommitment) {
    const preferred = notes.find(
      (candidate) => candidate.commitment.toLowerCase() === preferredCommitment
    );
    if (preferred) return preferred;
  }

  const envNoteCandidate = notes.find(
    (candidate) => candidate.commitment.toLowerCase() === note.commitment.toLowerCase()
  );
  if (envNoteCandidate) {
    return envNoteCandidate;
  }

  return notes[0];
};

const parsePaymentSignatureHeader = (rawHeader) => {
  const decoded = Buffer.from(rawHeader, 'base64').toString('utf8');
  const envelope = JSON.parse(decoded);
  if (!envelope || envelope.x402Version !== 2 || typeof envelope.signature !== 'string') {
    throw new Error('invalid PAYMENT-SIGNATURE envelope');
  }
  return envelope;
};

const resolveWalletContext = async (forceSync) => {
  if (forceSync) {
    syncResult = await walletState.sync();
  }
};

try {
  await resolveWalletContext(walletSyncOnStart);
} catch (error) {
  const snapshot = walletState.snapshot();
  const knownLeaf = snapshot.commitments.findIndex(
    (commitment) => commitment?.toLowerCase() === note.commitment.toLowerCase()
  );
  const hint = [
    'Unable to resolve witness for NOTE_* values.',
    `configuredCommitment=${note.commitment}`,
    `knownLeafIndexInState=${knownLeaf}`,
    `stateCommitmentCount=${snapshot.commitments.length}`,
    `stateLastSyncedBlock=${snapshot.lastSyncedBlock.toString()}`,
    'Ensure the exact NOTE_AMOUNT/NOTE_RHO/NOTE_PK_HASH commitment is deposited to SHIELDED_POOL_ADDRESS on the same chain as WALLET_INDEXER_URL.'
  ].join(' | ');
  throw new Error(`${hint} | cause=${error instanceof Error ? error.message : String(error)}`);
}

const creditClient = createCreditChannelClient({
  relayerEndpoint: creditRelayerEndpoint,
  ...(configuredChannelId ? { channelId: configuredChannelId } : {}),
  agentAddress: account.address,
  signer: {
    signTypedData: (args) => account.signTypedData(args)
  },
  stateStore: walletState
});

const ensureCreditTopup = async () => {
  const resolvedChannelId = await creditClient.getChannelId();
  console.log(`[credit] channelId=${resolvedChannelId}${configuredChannelId ? ' (configured)' : ' (derived)'}`);
  const existing = creditClient.getLatestState();
  if (existing) {
    console.log(
      `[credit] existing channel state seq=${existing.state.seq} available=${existing.state.available}`
    );
    return resolvedChannelId;
  }

  if (!creditTopupIfMissing) {
    throw new Error('No credit state found and CREDIT_TOPUP_IF_MISSING=false');
  }
  if (!creditPayTo || !creditPayTo.startsWith('0x')) {
    throw new Error('CREDIT_PAY_TO (or SHIELDED_POOL_ADDRESS) is required for credit topup');
  }
  if (!creditVerifyingContract || !creditVerifyingContract.startsWith('0x')) {
    throw new Error(
      'CREDIT_VERIFYING_CONTRACT (or SHIELDED_POOL_ADDRESS) is required for credit topup'
    );
  }

  const selected = pickSpendableNote(creditTopupAmountMicros);
  if (!selected) {
    throw new Error(
      [
        'no spendable note found in wallet-state for credit topup',
        `topup.amount=${creditTopupAmountMicros.toString()}`,
        'Deposit a new note with secrets (npm run seed-note) and/or sync wallet state, then retry.',
        `statePath=${walletStatePath}`
      ].join(' | ')
    );
  }

  const context = walletState.getSpendContextByCommitment(selected.commitment);
  const challengeNonce = `0x${randomBytes(32).toString('hex')}`;
  const prepared = await sdk.prepare402Payment(
    {
      x402Version: 2,
      scheme: 'exact',
      network: creditNetwork,
      asset: creditAsset,
      payTo: creditPayTo,
      rail: 'shielded-usdc',
      amount: creditTopupAmountMicros.toString(),
      challengeNonce,
      challengeExpiry: String(Math.floor(Date.now() / 1000) + creditTopupChallengeTtlSeconds),
      merchantPubKey: creditMerchantPubKey,
      verifyingContract: creditVerifyingContract
    },
    context.note,
    context.witness,
    context.nullifierSecret
  );

  const paymentHeader = prepared.headers.get('PAYMENT-SIGNATURE');
  if (!paymentHeader) {
    throw new Error('failed to create PAYMENT-SIGNATURE header for topup');
  }
  const paymentEnvelope = parsePaymentSignatureHeader(paymentHeader);
  const topupResult = await creditClient.topup({
    requestId: `credit-topup-${Date.now()}`,
    paymentPayload: prepared.response,
    paymentPayloadSignature: paymentEnvelope.signature
  });
  if (topupResult.status !== 'DONE') {
    throw new Error(topupResult.failureReason ?? 'credit topup failed');
  }

  await walletState.markNoteSpent(context.note.commitment);
  await walletState.addOrUpdateNote(prepared.changeNote, prepared.changeNullifierSecret);
  console.log(
    `[credit] topup complete seq=${topupResult.nextState?.seq ?? 'n/a'} available=${topupResult.nextState?.available ?? 'n/a'}`
  );
  return resolvedChannelId;
};

const resolvedChannelId = await ensureCreditTopup();

const creditFetch = createCreditShieldedFetch({
  creditClient
});
console.log(`[1/2] Calling existing x402 merchant endpoint via credit lane: ${payaiUrl}`);
console.log(
  [
    `[config] seedNoteAmount=${note.amount.toString()}`,
    `seedCommitment=${note.commitment}`,
    `preferredCommitment=${preferredCommitment ?? 'none'}`,
    `nullifierSecret=${nullifierSecret}`,
    `witnessMode=wallet-state`,
    `creditMode=true`,
    `creditRelayer=${creditRelayerEndpoint}`,
    `creditChannelId=${resolvedChannelId}`,
    `creditTopupAmount=${creditTopupAmountMicros.toString()}`,
    `syncSource=${walletIndexerUrl ? 'indexer' : 'rpc'}`,
    `statePath=${walletStatePath}`,
    `syncMode=${syncResult ? 'synced' : 'cached'}`,
    ...(syncResult
      ? [
          `syncedFrom=${syncResult.fromBlock.toString()}`,
          `syncedTo=${syncResult.toBlock.toString()}`,
          `depositsApplied=${syncResult.depositsApplied}`,
          `spendsApplied=${syncResult.spendsApplied}`
        ]
      : [])
  ].join(' ')
);

const startedAt = Date.now();
const response = await creditFetch(payaiUrl, { method: 'GET' });
const elapsed = Date.now() - startedAt;

console.log(`[2/2] status=${response.status} (${elapsed}ms)`);
console.log(`content-type=${response.headers.get('content-type') ?? 'unknown'}`);
console.log(`x-relayer-settlement-id=${response.headers.get('x-relayer-settlement-id') ?? 'n/a'}`);
console.log(`payment-required-header-present=${response.headers.has('payment-required')}`);
const paymentResponseHeader =
  response.headers.get('x-payment-response') ??
  response.headers.get('payment-response');
console.log(`x-payment-response-present=${Boolean(paymentResponseHeader)}`);
if (paymentResponseHeader) {
  try {
    const decoded = Buffer.from(paymentResponseHeader, 'base64').toString('utf8');
    console.log(`x-payment-response-decoded=${decoded}`);
  } catch {
    console.log('x-payment-response-decoded=<invalid base64>');
  }
}
const body = await response.text();
console.log(body);
