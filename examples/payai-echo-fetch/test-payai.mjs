import 'dotenv/config';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

const endpoint =
  process.env.PAYAI_ENDPOINT ?? 'https://x402.payai.network/api/base-sepolia/paid-content';
const privateKey = process.env.PRIVATE_KEY;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';

if (!privateKey || !privateKey.startsWith('0x')) {
  throw new Error('Set PRIVATE_KEY in .env (hex 0x-prefixed EVM key).');
}

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(rpcUrl)
});

const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

console.log(`Calling paid endpoint: ${endpoint}`);
const startedAt = Date.now();
const response = await fetchWithPayment(endpoint, { method: 'GET' });
const elapsed = Date.now() - startedAt;

console.log(`status=${response.status} (${elapsed}ms)`);
console.log(`content-type=${response.headers.get('content-type') ?? 'unknown'}`);

const contentType = response.headers.get('content-type') ?? '';
if (contentType.includes('application/json')) {
  console.log(JSON.stringify(await response.json(), null, 2));
} else if (contentType.startsWith('text/')) {
  console.log(await response.text());
} else {
  const bytes = new Uint8Array(await response.arrayBuffer());
  console.log(`binary payload bytes=${bytes.length}`);
}
