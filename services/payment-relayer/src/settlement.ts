import type { Hex, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createPublicClient, createWalletClient, http } from 'viem';
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
  }
] as const;

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

      const txHash = await walletClient.writeContract({
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

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`settlement tx reverted: ${txHash}`);
      }

      return { alreadySettled: false, txHash };
    }
  };
}
