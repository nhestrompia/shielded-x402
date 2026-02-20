import type { Hex, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SettlementAdapter } from './types.js';

const shieldedPoolSettlementAbi = [
  {
    type: 'function',
    name: 'isNullifierUsed',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'submitSpend',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proof', type: 'bytes' },
      { name: 'nullifier', type: 'bytes32' },
      { name: 'root', type: 'bytes32' },
      { name: 'merchantCommitment', type: 'bytes32' },
      { name: 'changeCommitment', type: 'bytes32' },
      { name: 'challengeHash', type: 'bytes32' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  },
  { type: 'error', name: 'InvalidAmount', inputs: [] },
  { type: 'error', name: 'InvalidCommitment', inputs: [] },
  { type: 'error', name: 'InvalidProof', inputs: [] },
  { type: 'error', name: 'InvalidProofSize', inputs: [] },
  { type: 'error', name: 'NullifierAlreadyUsed', inputs: [] },
  { type: 'error', name: 'UnknownRoot', inputs: [] }
] as const;

const spentEvent = parseAbiItem(
  'event Spent(bytes32 indexed nullifier, bytes32 indexed merchantCommitment, bytes32 indexed changeCommitment, uint256 amount, bytes32 challengeHash, uint256 merchantLeafIndex, uint256 changeLeafIndex, bytes32 newRoot)'
);

export interface OnchainSettlementConfig {
  rpcUrl: string;
  shieldedPoolAddress: Hex;
  relayerPrivateKey: Hex;
}

export function createNoopSettlement(): SettlementAdapter {
  return {
    settleOnchain: async () => ({
      alreadySettled: false,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
    })
  };
}

export function createOnchainSettlement(config: OnchainSettlementConfig): SettlementAdapter {
  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createPublicClient({
    transport: http(config.rpcUrl)
  });
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl)
  });

  return {
    settleOnchain: async (payload: ShieldedPaymentResponse) => {
      const amountWord = payload.publicInputs[5];
      if (!amountWord) {
        throw new Error('missing amount public input');
      }
      const amount = BigInt(amountWord);
      const alreadyUsed = await publicClient.readContract({
        address: config.shieldedPoolAddress,
        abi: shieldedPoolSettlementAbi,
        functionName: 'isNullifierUsed',
        args: [payload.nullifier]
      });
      if (alreadyUsed) {
        return { alreadySettled: true };
      }

      let txHash: Hex;
      try {
        txHash = await walletClient.writeContract({
          address: config.shieldedPoolAddress,
          abi: shieldedPoolSettlementAbi,
          functionName: 'submitSpend',
          chain: null,
          args: [
            payload.proof,
            payload.nullifier,
            payload.root,
            payload.merchantCommitment,
            payload.changeCommitment,
            payload.challengeHash,
            amount
          ],
          account
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shortMessage =
          error && typeof error === 'object' && 'shortMessage' in error
            ? String((error as { shortMessage?: unknown }).shortMessage ?? '')
            : '';
        if (shortMessage.length > 0) {
          throw new Error(`submitSpend failed: ${shortMessage}`);
        }
        throw new Error(`submitSpend failed: ${message}`);
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`settlement tx reverted: ${txHash}`);
      }
      let merchantLeafIndex: number | undefined;
      let changeLeafIndex: number | undefined;
      let newRoot: Hex | undefined;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.shieldedPoolAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: [spentEvent],
            data: log.data,
            topics: log.topics
          });
          if (decoded.eventName !== 'Spent') continue;
          const args = decoded.args as {
            merchantLeafIndex: bigint;
            changeLeafIndex: bigint;
            newRoot: Hex;
          };
          merchantLeafIndex = Number(args.merchantLeafIndex);
          changeLeafIndex = Number(args.changeLeafIndex);
          newRoot = args.newRoot;
        } catch {
          // Ignore non-Spent logs
        }
      }

      return {
        alreadySettled: false,
        txHash,
        ...(merchantLeafIndex !== undefined ? { merchantLeafIndex } : {}),
        ...(changeLeafIndex !== undefined ? { changeLeafIndex } : {}),
        ...(newRoot !== undefined ? { newRoot } : {})
      };
    }
  };
}
