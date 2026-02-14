import { concatHex, keccak256, type Hex } from 'viem';
import { CRYPTO_SPEC } from '@shielded-x402/shared-types';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

export interface MerkleWitness {
  root: Hex;
  path: Hex[];
  indexBits: number[];
}

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([left, right]));
}

export function buildZeroes(depth: number): Hex[] {
  const zeroes: Hex[] = [ZERO_BYTES32];
  for (let i = 1; i < depth; i += 1) {
    const prev = zeroes[i - 1] ?? ZERO_BYTES32;
    zeroes.push(hashPair(prev, prev));
  }
  return zeroes;
}

export function emptyRoot(depth: number = CRYPTO_SPEC.merkleTreeDepth): Hex {
  let current = ZERO_BYTES32;
  for (let i = 0; i < depth; i += 1) {
    current = hashPair(current, current);
  }
  return current;
}

export function deriveWitness(commitments: Hex[], targetIndex: number): MerkleWitness {
  const depth = CRYPTO_SPEC.merkleTreeDepth;
  if (targetIndex < 0 || targetIndex >= commitments.length) {
    throw new Error('targetIndex out of range');
  }
  if (commitments.length >= 2 ** depth) {
    throw new Error('commitment set exceeds tree capacity');
  }

  const zeroes = buildZeroes(depth);
  const path: Hex[] = [];
  const indexBits: number[] = [];

  let levelNodes = [...commitments];
  let idx = targetIndex;

  for (let level = 0; level < depth; level += 1) {
    const bit = idx & 1;
    indexBits.push(bit);

    const siblingIndex = bit === 0 ? idx + 1 : idx - 1;
    const sibling =
      siblingIndex < levelNodes.length
        ? (levelNodes[siblingIndex] ?? zeroes[level] ?? ZERO_BYTES32)
        : (zeroes[level] ?? ZERO_BYTES32);
    path.push(sibling);

    const nextLevel: Hex[] = [];
    for (let i = 0; i < levelNodes.length; i += 2) {
      const left = levelNodes[i] ?? ZERO_BYTES32;
      const right =
        i + 1 < levelNodes.length
          ? (levelNodes[i + 1] ?? zeroes[level] ?? ZERO_BYTES32)
          : (zeroes[level] ?? ZERO_BYTES32);
      nextLevel.push(hashPair(left, right));
    }

    levelNodes = nextLevel;
    idx = idx >> 1;
  }

  const root = levelNodes[0] ?? emptyRoot(depth);
  return { root, path, indexBits };
}

export function deriveRootFromCommitments(commitments: Hex[]): Hex {
  if (commitments.length === 0) {
    return emptyRoot(CRYPTO_SPEC.merkleTreeDepth);
  }
  return deriveWitness(commitments, 0).root;
}
