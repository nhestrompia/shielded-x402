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

const relayerEndpoint = process.env.RELAYER_ENDPOINT ?? 'http://127.0.0.1:3100';
const payaiUrl = process.env.PAYAI_URL ?? 'https://x402.payai.network/api/base-sepolia/paid-content';
const poolRpcUrl = process.env.POOL_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
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
const payerPkHash = toWord(parseEnvBigInt('PAYER_PK_HASH', 9n));

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
    backendProofOptions: { keccakZK: true }
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

await walletState.addOrUpdateNote(note);
let syncResult;
let resolvedContext;

const resolveWalletContext = async (forceSync) => {
  if (!forceSync) {
    try {
      return walletState.getSpendContextByCommitment(note.commitment, payerPkHash);
    } catch {}
  }

  syncResult = await walletState.sync();
  return walletState.getSpendContextByCommitment(note.commitment, payerPkHash);
};

try {
  resolvedContext = await resolveWalletContext(walletSyncOnStart);
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
  onRelayerSettlement: async ({ relayResponse, prepared }) => {
    if (relayResponse.status !== 'DONE') {
      return;
    }
    await walletState.applyRelayerSettlement({
      settlementDelta: relayResponse.settlementDelta,
      changeNote: prepared.changeNote
    });
  },
  resolveContext: async ({ requirement }) => {
    const requiredAmount = BigInt(requirement.amount);
    if (note.amount < requiredAmount) {
      throw new Error(
        [
          'insufficient note amount for merchant price',
          `note.amount=${note.amount.toString()}`,
          `requirement.amount=${requiredAmount.toString()}`,
          'Set NOTE_AMOUNT >= requirement.amount and deposit that note commitment to the pool before retrying.'
        ].join(' | ')
      );
    }
    return resolvedContext;
  }
});
console.log(`[1/2] Calling existing x402 merchant endpoint: ${payaiUrl}`);
console.log(
  [
    `[config] noteAmount=${note.amount.toString()}`,
    `commitment=${note.commitment}`,
    `payerPkHash=${payerPkHash}`,
    `leafIndex=${resolvedContext.note.leafIndex}`,
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
const body = await response.text();
console.log(body);
