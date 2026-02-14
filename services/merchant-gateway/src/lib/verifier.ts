import type { Hex, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createPublicClient, http } from 'viem';

export interface VerifierAdapter {
  verifyProof: (payload: ShieldedPaymentResponse) => Promise<boolean>;
  isNullifierUsed: (nullifier: Hex) => Promise<boolean>;
  markNullifierUsed?: (nullifier: Hex) => Promise<void>;
}

const ultraVerifierAbi = [
  {
    type: 'function',
    name: 'verify',
    stateMutability: 'view',
    inputs: [
      { name: 'proof', type: 'bytes' },
      { name: 'publicInputs', type: 'bytes32[]' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

const shieldedPoolReadAbi = [
  {
    type: 'function',
    name: 'isNullifierUsed',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'isKnownRoot',
    stateMutability: 'view',
    inputs: [{ name: 'root', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

export function createAllowAllVerifier(): VerifierAdapter {
  const seen = new Set<Hex>();
  return {
    verifyProof: async (payload) => payload.proof.startsWith('0x'),
    isNullifierUsed: async (nullifier) => seen.has(nullifier),
    markNullifierUsed: async (nullifier) => {
      seen.add(nullifier);
    }
  };
}

export interface OnchainVerifierConfig {
  rpcUrl: string;
  shieldedPoolAddress: Hex;
  ultraVerifierAddress: Hex;
}

export function createOnchainVerifier(config: OnchainVerifierConfig): VerifierAdapter {
  const client = createPublicClient({
    transport: http(config.rpcUrl)
  });

  return {
    verifyProof: async (payload) => {
      const rootKnown = await client.readContract({
        address: config.shieldedPoolAddress,
        abi: shieldedPoolReadAbi,
        functionName: 'isKnownRoot',
        args: [payload.root]
      });
      if (!rootKnown) return false;

      return client.readContract({
        address: config.ultraVerifierAddress,
        abi: ultraVerifierAbi,
        functionName: 'verify',
        args: [payload.proof, payload.publicInputs as Hex[]]
      });
    },
    isNullifierUsed: async (nullifier) => {
      return client.readContract({
        address: config.shieldedPoolAddress,
        abi: shieldedPoolReadAbi,
        functionName: 'isNullifierUsed',
        args: [nullifier]
      });
    },
    markNullifierUsed: async () => {
      // Nullifier state is authoritative on-chain.
    }
  };
}
