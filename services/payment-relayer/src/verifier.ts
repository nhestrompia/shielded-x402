import type { Hex, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createPublicClient, http } from 'viem';
import type { VerifierAdapter } from './types.js';

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
  },
  { type: 'error', name: 'ProofLengthWrong', inputs: [] },
  {
    type: 'error',
    name: 'ProofLengthWrongWithLogN',
    inputs: [
      { name: 'logN', type: 'uint256' },
      { name: 'actualLength', type: 'uint256' },
      { name: 'expectedLength', type: 'uint256' }
    ]
  },
  { type: 'error', name: 'PublicInputsLengthWrong', inputs: [] },
  { type: 'error', name: 'SumcheckFailed', inputs: [] },
  { type: 'error', name: 'ShpleminiFailed', inputs: [] },
  { type: 'error', name: 'GeminiChallengeInSubgroup', inputs: [] },
  { type: 'error', name: 'ConsistencyCheckFailed', inputs: [] }
] as const;

const knownVerifierErrorBySelector: Record<string, string> = {
  '0xed74ac0a': 'ProofLengthWrong',
  '0x59895a53': 'ProofLengthWrongWithLogN',
  '0xfa066593': 'PublicInputsLengthWrong',
  '0x9fc3a218': 'SumcheckFailed',
  '0xa5d82e8a': 'ShpleminiFailed',
  '0x835eb8f7': 'GeminiChallengeInSubgroup',
  '0xa2a2ac83': 'ConsistencyCheckFailed'
};

function selectorFromError(error: unknown): string | undefined {
  const text =
    error instanceof Error
      ? `${error.message}\n${String((error as { stack?: unknown }).stack ?? '')}`
      : String(error);
  const match = text.match(/0x[0-9a-fA-F]{8}/);
  return match ? match[0].toLowerCase() : undefined;
}

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
    verifyProof: async (payload: ShieldedPaymentResponse) => payload.proof.startsWith('0x'),
    isNullifierUsed: async (nullifier: Hex) => seen.has(nullifier)
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
      if (!rootKnown) {
        throw new Error(
          `unknown root on verifier chain (rpc=${config.rpcUrl}, pool=${config.shieldedPoolAddress}, root=${payload.root})`
        );
      }

      let verified: boolean;
      try {
        verified = await client.readContract({
          address: config.ultraVerifierAddress,
          abi: ultraVerifierAbi,
          functionName: 'verify',
          args: [payload.proof, payload.publicInputs as Hex[]]
        });
      } catch (error) {
        const shortMessage =
          error && typeof error === 'object' && 'shortMessage' in error
            ? String((error as { shortMessage?: unknown }).shortMessage ?? '')
            : '';
        const selector = selectorFromError(error);
        const knownName = selector ? knownVerifierErrorBySelector[selector] : undefined;
        if (knownName) {
          throw new Error(
            `verifier reverted: ${knownName} (selector=${selector}, verifier=${config.ultraVerifierAddress})`
          );
        }
        if (shortMessage.length > 0) {
          throw new Error(
            `verifier call reverted (verifier=${config.ultraVerifierAddress}): ${shortMessage}`
          );
        }
        throw error;
      }
      if (!verified) {
        throw new Error(
          `verifier returned false (verifier=${config.ultraVerifierAddress}, publicInputs=${payload.publicInputs.length})`
        );
      }
      return true;
    },
    isNullifierUsed: async (nullifier) => {
      return client.readContract({
        address: config.shieldedPoolAddress,
        abi: shieldedPoolReadAbi,
        functionName: 'isNullifierUsed',
        args: [nullifier]
      });
    }
  };
}
