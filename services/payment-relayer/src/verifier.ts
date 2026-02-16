import type { Hex, ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createPublicClient, decodeErrorResult, http } from 'viem';
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
  const explicit = text.match(/selector=0x[0-9a-fA-F]{8}/);
  if (explicit?.[0]) {
    const selector = explicit[0].split('=')[1];
    if (selector) return selector.toLowerCase();
  }
  return undefined;
}

function selectorFromNestedError(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === 'string') {
      const match = current.match(/selector=0x[0-9a-fA-F]{8}/);
      if (match?.[0]) {
        const selector = match[0].split('=')[1];
        if (selector) return selector.toLowerCase();
      }
      continue;
    }

    if (typeof current === 'object') {
      const maybeData = (current as { data?: unknown }).data;
      if (typeof maybeData === 'string') {
        const dataHex = maybeData.trim();
        if (/^0x[0-9a-fA-F]{10,}$/.test(dataHex) && dataHex.length !== 42) {
          return dataHex.slice(0, 10).toLowerCase();
        }
      }
      for (const value of Object.values(current as Record<string, unknown>)) {
        queue.push(value);
      }
    }
  }

  return undefined;
}

function revertDataFromError(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === 'object') {
      // Only trust explicit error data fields; avoid parsing arbitrary strings
      // (proof bytes can appear in stack/messages and look like revert data).
      const maybeData = (current as { data?: unknown }).data;
      if (typeof maybeData === 'string') {
        const dataHex = maybeData.trim();
        if (/^0x[0-9a-fA-F]{10,}$/.test(dataHex) && dataHex.length !== 42) {
          return dataHex.toLowerCase() as Hex;
        }
      }
      for (const value of Object.values(current as Record<string, unknown>)) {
        queue.push(value);
      }
    }
  }

  return undefined;
}

const shieldedPoolReadAbi = [
  {
    type: 'function',
    name: 'verifier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
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

const adapterReadAbi = [
  {
    type: 'function',
    name: 'verifier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  }
] as const;

const HASH_PUBLIC_INPUT_BYTES = 32;
const HASH_PUBLIC_INPUT_COUNT = 5;
const COMPACT_PUBLIC_INPUT_COUNT = 6;
const EXPANDED_PUBLIC_INPUT_COUNT = (HASH_PUBLIC_INPUT_BYTES * HASH_PUBLIC_INPUT_COUNT) + 1;

function expandCompactPublicInputs(compact: readonly Hex[]): Hex[] {
  if (compact.length !== COMPACT_PUBLIC_INPUT_COUNT) {
    throw new Error(`expected ${COMPACT_PUBLIC_INPUT_COUNT} compact public inputs, got ${compact.length}`);
  }

  const expanded: Hex[] = [];
  for (let i = 0; i < HASH_PUBLIC_INPUT_COUNT; i += 1) {
    const word = compact[i];
    if (!word) throw new Error(`missing compact public input at index ${i}`);
    const hex = word.slice(2).padStart(64, '0');
    for (let j = 0; j < HASH_PUBLIC_INPUT_BYTES; j += 1) {
      const byteHex = hex.slice(j * 2, j * 2 + 2);
      const byte = BigInt(`0x${byteHex}`);
      expanded.push(`0x${byte.toString(16).padStart(64, '0')}` as Hex);
    }
  }
  expanded.push(compact[5] as Hex);

  if (expanded.length !== EXPANDED_PUBLIC_INPUT_COUNT) {
    throw new Error(`expected ${EXPANDED_PUBLIC_INPUT_COUNT} expanded public inputs, got ${expanded.length}`);
  }
  return expanded;
}

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
  let resolvedVerifierAddress: Hex | null = null;
  let resolvedUltraVerifierAddress: Hex | null = null;
  let verifierIsAdapter = false;
  let verifierBindingNote: string | null = null;

  return {
    verifyProof: async (payload) => {
      if (!resolvedVerifierAddress) {
        const configured = config.ultraVerifierAddress.toLowerCase() as Hex;
        try {
          const poolVerifier = (await client.readContract({
            address: config.shieldedPoolAddress,
            abi: shieldedPoolReadAbi,
            functionName: 'verifier',
            args: []
          })) as Hex;
          const normalizedPoolVerifier = poolVerifier.toLowerCase() as Hex;
          resolvedVerifierAddress = normalizedPoolVerifier;
          if (normalizedPoolVerifier !== configured) {
            verifierBindingNote =
              `pool verifier auto-selected (${normalizedPoolVerifier}); configured verifier was ${configured}`;
          }
        } catch {
          // Fallback to configured verifier for non-standard pool contracts.
          resolvedVerifierAddress = configured;
        }

        try {
          const maybeUltra = (await client.readContract({
            address: resolvedVerifierAddress,
            abi: adapterReadAbi,
            functionName: 'verifier',
            args: []
          })) as Hex;
          resolvedUltraVerifierAddress = maybeUltra.toLowerCase() as Hex;
          verifierIsAdapter = true;
          const adapterNote = `adapter=${resolvedVerifierAddress} ultra=${resolvedUltraVerifierAddress}`;
          verifierBindingNote = verifierBindingNote
            ? `${verifierBindingNote}; ${adapterNote}`
            : adapterNote;
        } catch {
          resolvedUltraVerifierAddress = resolvedVerifierAddress;
          verifierIsAdapter = false;
        }
      }

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
        const verifyAddress =
          (verifierIsAdapter ? resolvedUltraVerifierAddress : resolvedVerifierAddress) as Hex;
        const verifyInputs = verifierIsAdapter
          ? expandCompactPublicInputs(payload.publicInputs as Hex[])
          : (payload.publicInputs as Hex[]);

        verified = await client.readContract({
          address: verifyAddress,
          abi: ultraVerifierAbi,
          functionName: 'verify',
          args: [payload.proof, verifyInputs]
        });
      } catch (error) {
        const shortMessage =
          error && typeof error === 'object' && 'shortMessage' in error
            ? String((error as { shortMessage?: unknown }).shortMessage ?? '')
            : '';
        const revertData = revertDataFromError(error);
        const selector =
          (revertData ? (revertData.slice(0, 10).toLowerCase() as string) : undefined) ??
          selectorFromNestedError(error) ??
          selectorFromError(error);
        const decodedName = (() => {
          if (!revertData) return undefined;
          try {
            const decoded = decodeErrorResult({
              abi: ultraVerifierAbi,
              data: revertData
            });
            return decoded.errorName;
          } catch {
            return undefined;
          }
        })();
        const knownName = decodedName ?? (selector ? knownVerifierErrorBySelector[selector] : undefined);
        if (knownName) {
          throw new Error(
            `verifier reverted: ${knownName} (selector=${selector}, verifier=${resolvedUltraVerifierAddress ?? resolvedVerifierAddress})${verifierBindingNote ? `; ${verifierBindingNote}` : ''}`
          );
        }
        if (shortMessage.length > 0) {
          const selectorHint = selector ? ` selector=${selector}.` : '';
          throw new Error(
            `verifier call reverted (verifier=${resolvedUltraVerifierAddress ?? resolvedVerifierAddress}): ${shortMessage}.${selectorHint}${verifierBindingNote ? ` ${verifierBindingNote}` : ''}`
          );
        }
        throw error;
      }
      if (!verified) {
        throw new Error(
          `verifier returned false (verifier=${resolvedUltraVerifierAddress ?? resolvedVerifierAddress}, publicInputs=${payload.publicInputs.length})${verifierBindingNote ? `; ${verifierBindingNote}` : ''}`
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
