import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { FileBackedWalletState, deriveCommitment } from '@shielded-x402/client';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  isAddress,
  parseAbiItem
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '.env'), override: true });

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const toWord = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const parseEnvBigInt = (key, fallback) => {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  return BigInt(raw);
};
const isFieldSafe = (n) => n >= 0n && n < BN254_FIELD_MODULUS;
const randomFieldSafeWord = () => {
  while (true) {
    const candidate = BigInt(`0x${randomBytes(32).toString('hex')}`);
    if (isFieldSafe(candidate)) {
      return toWord(candidate);
    }
  }
};

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL ??
  process.env.POOL_RPC_URL ??
  process.env.SEPOLIA_RPC_URL;
const usdcAddress = process.env.USDC_ADDRESS;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS;
const walletStatePath = process.env.WALLET_STATE_PATH ?? './wallet-state.json';
const walletIndexerUrl = process.env.WALLET_INDEXER_URL;
const poolFromBlock = parseEnvBigInt('POOL_FROM_BLOCK', 0n);
const noteAmount = parseEnvBigInt('NOTE_AMOUNT', 1_000_000n);
const notePkHash = toWord(parseEnvBigInt('NOTE_PK_HASH', 11n));
const depositorPrivateKey =
  process.env.DEPOSITOR_PRIVATE_KEY ??
  process.env.PAYER_PRIVATE_KEY ??
  process.env.DEPLOYER_PRIVATE_KEY;

if (!rpcUrl) throw new Error('Set BASE_SEPOLIA_RPC_URL (or POOL_RPC_URL/SEPOLIA_RPC_URL)');
if (!usdcAddress || !isAddress(usdcAddress)) throw new Error('Set valid USDC_ADDRESS');
if (!shieldedPoolAddress || !isAddress(shieldedPoolAddress)) {
  throw new Error('Set valid SHIELDED_POOL_ADDRESS');
}
if (!depositorPrivateKey || !depositorPrivateKey.startsWith('0x')) {
  throw new Error('Set DEPOSITOR_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY/PAYER_PRIVATE_KEY)');
}

const useFixedRho = (process.env.SEED_USE_FIXED_RHO ?? 'false').trim().toLowerCase() === 'true';
const rawNoteRho = useFixedRho ? process.env.NOTE_RHO?.trim() : undefined;
const noteRhoWord =
  rawNoteRho && rawNoteRho.length > 0
    ? toWord(BigInt(rawNoteRho))
    : randomFieldSafeWord();
const noteRhoDecimal = BigInt(noteRhoWord).toString();
if (!isFieldSafe(BigInt(noteRhoWord))) {
  throw new Error(
    `NOTE_RHO is not BN254 field-safe (${noteRhoDecimal}); set SEED_USE_FIXED_RHO=false or provide smaller NOTE_RHO`
  );
}
const useFixedNullifierSecret =
  (process.env.SEED_USE_FIXED_NULLIFIER_SECRET ?? 'false').trim().toLowerCase() === 'true';
const rawNullifierSecret = useFixedNullifierSecret ? process.env.NULLIFIER_SECRET?.trim() : undefined;
const nullifierSecretWord =
  rawNullifierSecret && rawNullifierSecret.length > 0
    ? toWord(BigInt(rawNullifierSecret))
    : randomFieldSafeWord();
const nullifierSecretDecimal = BigInt(nullifierSecretWord).toString();
if (!isFieldSafe(BigInt(nullifierSecretWord))) {
  throw new Error(
    `NULLIFIER_SECRET is not BN254 field-safe (${nullifierSecretDecimal}); set SEED_USE_FIXED_NULLIFIER_SECRET=false or provide smaller NULLIFIER_SECRET`
  );
}
const commitment = deriveCommitment(noteAmount, noteRhoWord, notePkHash);

const account = privateKeyToAccount(depositorPrivateKey);
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

const usdcAbi = [
  parseAbiItem('function balanceOf(address) view returns (uint256)'),
  parseAbiItem('function allowance(address,address) view returns (uint256)'),
  parseAbiItem('function approve(address,uint256) returns (bool)')
];
const poolAbi = [
  parseAbiItem('function asset() view returns (address)'),
  parseAbiItem(
    'event Deposited(bytes32 indexed commitment, uint256 indexed leafIndex, bytes32 indexed root, uint256 amount)'
  )
];

const poolAsset = await publicClient.readContract({
  address: shieldedPoolAddress,
  abi: poolAbi,
  functionName: 'asset'
});
if (poolAsset.toLowerCase() !== usdcAddress.toLowerCase()) {
  throw new Error(
    `pool asset mismatch: pool.asset=${poolAsset} env.USDC_ADDRESS=${usdcAddress}`
  );
}

const usdcBalance = await publicClient.readContract({
  address: usdcAddress,
  abi: usdcAbi,
  functionName: 'balanceOf',
  args: [account.address]
});
if (usdcBalance < noteAmount) {
  throw new Error(
    `insufficient USDC balance for depositor ${account.address}: balance=${usdcBalance.toString()} required=${noteAmount.toString()}`
  );
}

const nativeBalance = await publicClient.getBalance({ address: account.address });
const chainId = await publicClient.getChainId();
const minimumNativeForGasWei = 10_000_000_000_000n; // 0.00001 ETH
if (nativeBalance < minimumNativeForGasWei) {
  throw new Error(
    [
      `insufficient native gas balance for depositor ${account.address}`,
      `chainId=${chainId}`,
      `nativeBalanceWei=${nativeBalance.toString()}`,
      `requiredAtLeastWei=${minimumNativeForGasWei.toString()}`,
      'Fund this address with Base Sepolia ETH and retry seed-note.'
    ].join(' | ')
  );
}

const allowance = await publicClient.readContract({
  address: usdcAddress,
  abi: usdcAbi,
  functionName: 'allowance',
  args: [account.address, shieldedPoolAddress]
});
if (allowance < noteAmount) {
  const approveHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: 'approve',
    args: [shieldedPoolAddress, noteAmount]
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
}

const depositHash = await walletClient.writeContract({
  address: shieldedPoolAddress,
  abi: [parseAbiItem('function deposit(uint256,bytes32)')],
  functionName: 'deposit',
  args: [noteAmount, commitment]
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
if (receipt.status !== 'success') {
  throw new Error(`deposit transaction failed: ${depositHash}`);
}

const depositedEvent = parseAbiItem(
  'event Deposited(bytes32 indexed commitment, uint256 indexed leafIndex, bytes32 indexed root, uint256 amount)'
);
let leafIndex = -1;
for (const log of receipt.logs) {
  if (!log.address || log.address.toLowerCase() !== shieldedPoolAddress.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({
      abi: [depositedEvent],
      data: log.data,
      topics: log.topics
    });
    if (decoded.eventName === 'Deposited') {
      const args = decoded.args;
      if (args.commitment?.toLowerCase() === commitment.toLowerCase()) {
        leafIndex = Number(args.leafIndex);
        break;
      }
    }
  } catch {
    // ignore non-matching logs
  }
}

const walletState = await FileBackedWalletState.create({
  filePath: walletStatePath,
  ...(walletIndexerUrl ? { indexerGraphqlUrl: walletIndexerUrl } : {}),
  shieldedPoolAddress,
  startBlock: poolFromBlock
});
await walletState.addOrUpdateNote(
  {
    amount: noteAmount,
    rho: noteRhoWord,
    pkHash: notePkHash,
    commitment,
    leafIndex
  },
  nullifierSecretWord,
  receipt.blockNumber
);

console.log('[seed-note] deposited and stored note in wallet-state');
console.log(`[seed-note] txHash=${depositHash}`);
console.log(`[seed-note] leafIndex=${leafIndex}`);
console.log(`[seed-note] block=${receipt.blockNumber.toString()}`);
console.log(`[seed-note] NOTE_AMOUNT=${noteAmount.toString()}`);
console.log(`[seed-note] NOTE_RHO=${noteRhoDecimal}`);
console.log(`[seed-note] NOTE_PK_HASH=${BigInt(notePkHash).toString()}`);
console.log(`[seed-note] NULLIFIER_SECRET=${nullifierSecretDecimal}`);
console.log(`[seed-note] NOTE_COMMITMENT=${commitment}`);
console.log(`[seed-note] SEED_USE_FIXED_RHO=${useFixedRho}`);
console.log(`[seed-note] SEED_USE_FIXED_NULLIFIER_SECRET=${useFixedNullifierSecret}`);
console.log('[seed-note] export these before npm run start if needed:');
console.log(`export NOTE_AMOUNT=${noteAmount.toString()}`);
console.log(`export NOTE_RHO=${noteRhoDecimal}`);
console.log(`export NOTE_PK_HASH=${BigInt(notePkHash).toString()}`);
console.log(`export NULLIFIER_SECRET=${nullifierSecretDecimal}`);
console.log(`export NOTE_COMMITMENT=${commitment}`);
