import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface EvmNativeTransferRequest {
  rpcUrl: string;
  privateKey: Hex;
  recipient: Address;
  amountWei: bigint;
  chainId?: number;
}

function sanitizePrivateKey(raw: string): Hex {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `invalid private key format (expected 0x + 64 hex chars, len=${trimmed.length})`
    );
  }
  return trimmed.toLowerCase() as Hex;
}

export async function submitEvmNativeTransfer(
  request: EvmNativeTransferRequest
): Promise<{ txHash: Hex }> {
  const privateKey = sanitizePrivateKey(String(request.privateKey));
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    transport: http(request.rpcUrl)
  });
  const walletClient = createWalletClient({
    account,
    transport: http(request.rpcUrl)
  });

  const txHash = await walletClient.sendTransaction({
    account,
    to: request.recipient,
    value: request.amountWei,
    chain: request.chainId ? ({ id: request.chainId } as any) : undefined
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`evm transaction reverted: ${txHash}`);
  }

  return { txHash };
}
