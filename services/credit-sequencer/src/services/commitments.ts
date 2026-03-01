import {
  buildMerkleProof,
  buildMerkleRoot,
  deriveLeafSalt,
  type AuthorizationV1,
  type Hex,
  type InclusionProofV1
} from '@shielded-x402/shared-types';
import { normalizeHex } from '@shielded-x402/shared-types';
import type { Pool } from 'pg';
import { keyIdToBytes32 } from '../lib.js';

export const commitmentRegistryAbi = [
  {
    type: 'function',
    name: 'postCommitment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint64' },
      { name: 'root', type: 'bytes32' },
      { name: 'count', type: 'uint32' },
      { name: 'prevRoot', type: 'bytes32' },
      { name: 'sequencerKeyId', type: 'bytes32' }
    ],
    outputs: []
  }
] as const;

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function indexFromLogSeqNo(leaves: Array<{ log_seq_no: string }>, targetLogSeqNo: string): number {
  return leaves.findIndex((leaf) => leaf.log_seq_no === targetLogSeqNo);
}

async function runtimeImport(moduleName: string): Promise<any> {
  return import(moduleName);
}

export async function buildInclusionProof(input: {
  pool: Pool;
  authId: Hex;
  leafSaltSecret: Hex;
}): Promise<InclusionProofV1> {
  const authRes = await input.pool.query<{
    auth_id: string;
    authorization_json: AuthorizationV1;
    sequencer_key_id: string;
    log_seq_no: string;
  }>(
    `SELECT auth_id, authorization_json, sequencer_key_id, log_seq_no
     FROM authorizations
     WHERE auth_id = $1`,
    [input.authId]
  );
  const auth = authRes.rows[0];
  if (!auth) throw new Error('authorization not found');

  const leafRes = await input.pool.query<{
    leaf_hash: string;
    log_seq_no: string;
    epoch_id: string | null;
  }>(
    `SELECT leaf_hash, log_seq_no, epoch_id
     FROM auth_leaves
     WHERE auth_id = $1`,
    [input.authId]
  );
  const leaf = leafRes.rows[0];
  if (!leaf) throw new Error('authorization leaf not found');
  if (!leaf.epoch_id) throw new Error('authorization not committed yet');

  const commitmentRes = await input.pool.query<{
    epoch_id: string;
    root: string;
    prev_root: string;
    posted_tx_hash: string | null;
  }>(
    `SELECT epoch_id, root, prev_root, posted_tx_hash
     FROM commitments
     WHERE epoch_id = $1`,
    [leaf.epoch_id]
  );
  const commitment = commitmentRes.rows[0];
  if (!commitment) throw new Error('commitment epoch not found');

  const epochLeavesRes = await input.pool.query<{
    leaf_hash: string;
    log_seq_no: string;
  }>(
    `SELECT leaf_hash, log_seq_no
     FROM auth_leaves
     WHERE epoch_id = $1
     ORDER BY log_seq_no ASC`,
    [leaf.epoch_id]
  );
  const epochLeaves = epochLeavesRes.rows.map((row: { leaf_hash: string }) => normalizeHex(row.leaf_hash));
  const leafIndex = indexFromLogSeqNo(epochLeavesRes.rows, leaf.log_seq_no);
  if (leafIndex < 0) throw new Error('leaf index not found');
  const merkleProof = buildMerkleProof(epochLeaves, leafIndex);
  const recomputedRoot = buildMerkleRoot(epochLeaves);
  if (normalizeHex(recomputedRoot) !== normalizeHex(commitment.root)) {
    throw new Error('commitment root mismatch for epoch');
  }

  return {
    epochId: leaf.epoch_id,
    root: normalizeHex(commitment.root),
    leafHash: normalizeHex(leaf.leaf_hash),
    merkleProof,
    leafIndex,
    logSeqNo: auth.log_seq_no,
    prevRoot: normalizeHex(commitment.prev_root),
    authId: normalizeHex(auth.auth_id),
    leafSalt: deriveLeafSalt(input.leafSaltSecret, normalizeHex(auth.auth_id)),
    sequencerKeyId: auth.sequencer_key_id,
    ...(commitment.posted_tx_hash ? { commitTxHash: normalizeHex(commitment.posted_tx_hash) } : {})
  };
}

export async function runCommitmentEpoch(input: {
  pool: Pool;
  sequencerKeyId: string;
  baseRegistryAddress: Hex | undefined;
  basePosterPrivateKey: Hex | undefined;
  baseRpcUrl: string | undefined;
}): Promise<{ committed: boolean; epochId?: string; root?: Hex }> {
  const commitResult = await input.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');

      const countersRes = await client.query<{
        last_epoch_id: string;
        last_root: string;
      }>(
        `SELECT last_epoch_id, last_root
         FROM sequencer_counters
         WHERE singleton = TRUE
         FOR UPDATE`
      );
      const counters = countersRes.rows[0];
      if (!counters) throw new Error('sequencer counters missing');

      const leavesRes = await client.query<{
        log_seq_no: string;
        leaf_hash: string;
      }>(
        `SELECT log_seq_no, leaf_hash
         FROM auth_leaves
         WHERE epoch_id IS NULL
         ORDER BY log_seq_no ASC
         FOR UPDATE`
      );
      if (leavesRes.rowCount === 0) {
        await client.query('COMMIT');
        return { committed: false as const };
      }
      const epochId = (BigInt(counters.last_epoch_id) + 1n).toString();
      const leaves = leavesRes.rows.map((row: { leaf_hash: string }) => normalizeHex(row.leaf_hash));
      const root = buildMerkleRoot(leaves);
      const prevRoot = normalizeHex(counters.last_root);
      const maxLogSeqNo = leavesRes.rows[leavesRes.rows.length - 1]?.log_seq_no ?? '0';

      await client.query(
        `UPDATE auth_leaves
         SET epoch_id = $1
         WHERE epoch_id IS NULL`,
        [epochId]
      );

      await client.query(
        `INSERT INTO commitments(epoch_id, root, count, prev_root, sequencer_key_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [epochId, root, leaves.length, prevRoot, input.sequencerKeyId]
      );

      await client.query(
        `UPDATE sequencer_counters
         SET last_epoch_id = $1, last_root = $2, log_seq_no = GREATEST(log_seq_no, $3)
         WHERE singleton = TRUE`,
        [epochId, root, maxLogSeqNo]
      );

      await client.query('COMMIT');
      return {
        committed: true as const,
        epochId,
        root
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  if (!commitResult.committed) {
    return commitResult;
  }

  if (
    input.baseRegistryAddress &&
    input.basePosterPrivateKey &&
    input.baseRpcUrl &&
    commitResult.epochId &&
    commitResult.root
  ) {
    try {
      const viem = await runtimeImport('viem');
      const viemAccounts = await runtimeImport('viem/accounts');
      const viemChains = await runtimeImport('viem/chains');

      const account = viemAccounts.privateKeyToAccount(input.basePosterPrivateKey);
      const wallet = viem.createWalletClient({
        account,
        chain: viemChains.baseSepolia,
        transport: viem.http(input.baseRpcUrl)
      });
      const publicClient = viem.createPublicClient({
        chain: viemChains.baseSepolia,
        transport: viem.http(input.baseRpcUrl)
      });

      const prevCommitRes = await input.pool.query<{ prev_root: string; count: number }>(
        `SELECT prev_root, count
         FROM commitments
         WHERE epoch_id = $1`,
        [commitResult.epochId]
      );
      const prevCommit = prevCommitRes.rows[0];
      if (!prevCommit) throw new Error('commitment row missing after insert');

      const txHash = await wallet.writeContract({
        address: input.baseRegistryAddress,
        abi: commitmentRegistryAbi,
        functionName: 'postCommitment',
        args: [
          BigInt(commitResult.epochId),
          commitResult.root,
          prevCommit.count,
          normalizeHex(prevCommit.prev_root),
          keyIdToBytes32(input.sequencerKeyId)
        ]
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await input.pool.query(
        `UPDATE commitments
         SET posted_tx_hash = $2, posted_at = $3
         WHERE epoch_id = $1`,
        [commitResult.epochId, txHash, nowSeconds().toString()]
      );
    } catch (error) {
      console.error('[sequencer] failed posting commitment to Base', error);
    }
  } else {
    await input.pool.query(
      `UPDATE commitments
       SET posted_at = $2
       WHERE epoch_id = $1`,
      [commitResult.epochId, nowSeconds().toString()]
    );
  }

  return commitResult;
}
