import 'dotenv/config';
import {
  FileBackedWalletState,
  ShieldedClientSDK,
  createNoirJsProofProviderFromDefaultCircuit,
  createShieldedFetch,
  deriveCommitment
} from '@shielded-x402/client';
import { privateKeyToAccount } from 'viem/accounts';

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

if (!payerPrivateKey || !payerPrivateKey.startsWith('0x')) {
  throw new Error('Set PAYER_PRIVATE_KEY in .env');
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
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit({
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

const shieldedFetch = createShieldedFetch({
  sdk,
  relayerEndpoint,
  onRelayerSettlement: async ({ relayResponse, prepared, context }) => {
    if (relayResponse.settlementDelta) {
      await walletState.applyRelayerSettlement({
        settlementDelta: relayResponse.settlementDelta,
        changeNote: prepared.changeNote,
        changeNullifierSecret: prepared.changeNullifierSecret,
        spentNoteCommitment: context.note.commitment
      });
      return;
    }

    const failureReason = relayResponse.failureReason?.toLowerCase() ?? '';
    if (
      relayResponse.status === 'FAILED' &&
      failureReason.includes('nullifier already used')
    ) {
      await walletState.markNoteSpent(context.note.commitment);
      return;
    }

    if (relayResponse.status !== 'DONE') {
      return;
    }
  },
  resolveContext: async ({ requirement }) => {
    const requiredAmount = BigInt(requirement.amount);
    const selected = pickSpendableNote(requiredAmount);
    if (!selected) {
      throw new Error(
        [
          'no spendable note found in wallet-state',
          `requirement.amount=${requiredAmount.toString()}`,
          'Deposit a new note with secrets (npm run seed-note) and/or sync wallet state, then retry.',
          `statePath=${walletStatePath}`
        ].join(' | ')
      );
    }

    return walletState.getSpendContextByCommitment(selected.commitment);
  }
});
console.log(`[1/2] Calling existing x402 merchant endpoint: ${payaiUrl}`);
console.log(
  [
    `[config] seedNoteAmount=${note.amount.toString()}`,
    `seedCommitment=${note.commitment}`,
    `preferredCommitment=${preferredCommitment ?? 'none'}`,
    `nullifierSecret=${nullifierSecret}`,
    `witnessMode=wallet-state`,
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
const response = await shieldedFetch(payaiUrl, { method: 'GET' });
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
