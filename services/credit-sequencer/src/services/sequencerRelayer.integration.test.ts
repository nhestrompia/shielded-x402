import {
  buildIntentTypedDataPayload,
  buildReclaimTypedDataPayload,
  canonicalExecutionReportBytes,
  canonicalIntentBytes,
  deriveAgentIdFromPubKey,
  type ExecutionReportV1,
  type IntentV1
} from '../../../../packages/shared-types/src/sequencer.js';
import { normalizeHex } from '../../../../packages/shared-types/src/hex.js';
import type { Hex } from '../../../../packages/shared-types/src/types.js';
import { createPublicKey, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEd25519PrivateKeyFromSeed, extractEd25519RawPublicKey, sha256 } from '../crypto.js';
import { runMigrations } from '../db/migrate.js';
import { seedRelayerKeys } from '../db/schema.js';
import { buildInclusionProof, runCommitmentEpoch } from './commitments.js';
import { authorizeIntent, reclaimAuthorization, recordExecution } from './ledger.js';

vi.mock(
  '@shielded-x402/shared-types',
  async () => await import('../../../../packages/shared-types/src/index.js'),
  { virtual: true }
);

const ZERO_HASH = (`0x${'00'.repeat(32)}` as Hex);
const LEAF_SALT_SECRET = (`0x${'aa'.repeat(32)}` as Hex);
const EXECUTION_GRACE_SECONDS = 600n;
const DB_URL =
  process.env.SEQUENCER_TEST_DATABASE_URL ??
  process.env.SEQUENCER_DATABASE_URL ??
  '';

const describeIfDb = DB_URL ? describe : describe.skip;

function fixedSeed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte & 0xff);
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function resetDatabase(pool: any): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE
       execution_attempts,
       executions,
       auth_leaves,
       authorizations,
       idempotency_keys,
       relayer_keys,
       commitments,
       agents
     RESTART IDENTITY`
  );
  await pool.query(
    `UPDATE sequencer_counters
     SET log_seq_no = 0, last_leaf_hash = $1, last_epoch_id = 0, last_root = $1
     WHERE singleton = TRUE`,
    [ZERO_HASH]
  );
}

describeIfDb('sequencer + relayer + postgres integration', () => {
  let pool: any;

  beforeAll(async () => {
    const pg = await import('pg');
    pool = new pg.Pool({ connectionString: DB_URL });
    await runMigrations(DB_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('authorizes, records relayer execution, commits epoch, and serves inclusion proof', async () => {
    const sequencerPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(1));
    const agentPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(2));
    const relayerPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(3));
    const relayerPublicKey = extractEd25519RawPublicKey(createPublicKey(relayerPrivateKey));

    const chainRef = 'solana:devnet';
    const agentPubKey = extractEd25519RawPublicKey(createPublicKey(agentPrivateKey));
    const agentId = deriveAgentIdFromPubKey(agentPubKey);

    await pool.query(
      `INSERT INTO agents(
         agent_id, agent_pub_key, signature_scheme, balance_micros,
         next_agent_nonce, credited_micros, debited_outstanding_micros, updated_at
       ) VALUES ($1, $2, $3, $4, 0, $4, 0, $5)`,
      [agentId, agentPubKey, 'ed25519-sha256-v1', '100000', nowSeconds().toString()]
    );
    await seedRelayerKeys(pool, [{ chainRef, keyId: 'relayer-key-1', publicKey: relayerPublicKey }]);

    const intent: IntentV1 = {
      version: 1,
      agentId,
      agentPubKey,
      signatureScheme: 'ed25519-sha256-v1',
      agentNonce: '0',
      amountMicros: '1000',
      merchantId: (`0x${'44'.repeat(32)}` as Hex),
      requiredChainRef: chainRef,
      expiresAt: (nowSeconds() + 300n).toString(),
      requestId: (`0x${'55'.repeat(32)}` as Hex)
    };
    const agentSig = (`0x${sign(null, sha256(canonicalIntentBytes(intent)), agentPrivateKey).toString('hex')}` as Hex);

    const authorizeResponse = await authorizeIntent({
      pool,
      intent,
      agentSig,
      sequencerKeyId: 'seq-key-1',
      sequencerPrivateKey,
      leafSaltSecret: LEAF_SALT_SECRET,
      executionGraceSeconds: EXECUTION_GRACE_SECONDS,
      supportedChainRefs: new Set([chainRef])
    });

    const reportPayload = {
      authId: authorizeResponse.authorization.authId,
      chainRef,
      executionTxHash: `0x${'66'.repeat(32)}`,
      status: 'SUCCESS' as const,
      reportId: (`0x${'77'.repeat(32)}` as Hex),
      reportedAt: nowSeconds().toString(),
      relayerKeyId: 'relayer-key-1'
    };
    const reportSig = (`0x${sign(null, sha256(canonicalExecutionReportBytes(reportPayload)), relayerPrivateKey).toString('hex')}` as Hex);
    const report: ExecutionReportV1 = {
      ...reportPayload,
      reportSig
    };

    const executionResult = await recordExecution({
      pool,
      report
    });
    expect(executionResult.ok).toBe(true);

    const committed = await runCommitmentEpoch({
      pool,
      sequencerKeyId: 'seq-key-1',
      baseRegistryAddress: undefined,
      basePosterPrivateKey: undefined,
      baseRpcUrl: undefined
    });
    expect(committed.committed).toBe(true);

    const proof = await buildInclusionProof({
      pool,
      authId: authorizeResponse.authorization.authId,
      leafSaltSecret: LEAF_SALT_SECRET
    });
    expect(proof.authId).toBe(authorizeResponse.authorization.authId);
    expect(proof.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proof.sequencerKeyId).toBe('seq-key-1');
  });

  it('rejects conflicting execution tx hashes for the same authId', async () => {
    const sequencerPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(10));
    const agentPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(11));
    const relayerPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(12));
    const relayerPublicKey = extractEd25519RawPublicKey(createPublicKey(relayerPrivateKey));

    const chainRef = 'solana:devnet';
    const agentPubKey = extractEd25519RawPublicKey(createPublicKey(agentPrivateKey));
    const agentId = deriveAgentIdFromPubKey(agentPubKey);

    await pool.query(
      `INSERT INTO agents(
         agent_id, agent_pub_key, signature_scheme, balance_micros,
         next_agent_nonce, credited_micros, debited_outstanding_micros, updated_at
       ) VALUES ($1, $2, $3, $4, 0, $4, 0, $5)`,
      [agentId, agentPubKey, 'ed25519-sha256-v1', '100000', nowSeconds().toString()]
    );
    await seedRelayerKeys(pool, [{ chainRef, keyId: 'relayer-key-1', publicKey: relayerPublicKey }]);

    const intent: IntentV1 = {
      version: 1,
      agentId,
      agentPubKey,
      signatureScheme: 'ed25519-sha256-v1',
      agentNonce: '0',
      amountMicros: '1000',
      merchantId: (`0x${'88'.repeat(32)}` as Hex),
      requiredChainRef: chainRef,
      expiresAt: (nowSeconds() + 300n).toString(),
      requestId: (`0x${'99'.repeat(32)}` as Hex)
    };
    const agentSig = (`0x${sign(null, sha256(canonicalIntentBytes(intent)), agentPrivateKey).toString('hex')}` as Hex);
    const authorizeResponse = await authorizeIntent({
      pool,
      intent,
      agentSig,
      sequencerKeyId: 'seq-key-1',
      sequencerPrivateKey,
      leafSaltSecret: LEAF_SALT_SECRET,
      executionGraceSeconds: EXECUTION_GRACE_SECONDS,
      supportedChainRefs: new Set([chainRef])
    });

    const makeReport = (reportId: Hex, txHash: string): ExecutionReportV1 => {
      const payload = {
        authId: authorizeResponse.authorization.authId,
        chainRef,
        executionTxHash: txHash,
        status: 'SUCCESS' as const,
        reportId,
        reportedAt: nowSeconds().toString(),
        relayerKeyId: 'relayer-key-1'
      };
      const sigHex = (`0x${sign(null, sha256(canonicalExecutionReportBytes(payload)), relayerPrivateKey).toString('hex')}` as Hex);
      return { ...payload, reportSig: sigHex };
    };

    await recordExecution({
      pool,
      report: makeReport((`0x${'ab'.repeat(32)}` as Hex), `0x${'cd'.repeat(32)}`)
    });
    await expect(
      recordExecution({
        pool,
        report: makeReport((`0x${'ef'.repeat(32)}` as Hex), `0x${'12'.repeat(32)}`)
      })
    ).rejects.toThrow('CONFLICT_EXECUTION');
  });

  it('accepts eip712 agent reclaim signatures after expiry', async () => {
    const viemAccounts = await import('viem/accounts');
    const account = viemAccounts.privateKeyToAccount(`0x${'13'.repeat(32)}`);
    const sequencerPrivateKey = createEd25519PrivateKeyFromSeed(fixedSeed(14));
    const chainRef = 'solana:devnet';
    const agentPubKey = normalizeHex(account.address);
    const agentId = deriveAgentIdFromPubKey(agentPubKey);

    await pool.query(
      `INSERT INTO agents(
         agent_id, agent_pub_key, signature_scheme, balance_micros,
         next_agent_nonce, credited_micros, debited_outstanding_micros, updated_at
       ) VALUES ($1, $2, $3, $4, 0, $4, 0, $5)`,
      [agentId, agentPubKey, 'eip712-secp256k1', '5000', nowSeconds().toString()]
    );

    const intent: IntentV1 = {
      version: 1,
      agentId,
      agentPubKey,
      signatureScheme: 'eip712-secp256k1',
      agentNonce: '0',
      amountMicros: '1000',
      merchantId: (`0x${'22'.repeat(32)}` as Hex),
      requiredChainRef: chainRef,
      expiresAt: (nowSeconds() + 1n).toString(),
      requestId: (`0x${'33'.repeat(32)}` as Hex)
    };
    const agentSig = await account.signTypedData(buildIntentTypedDataPayload(intent));

    const authorizeResponse = await authorizeIntent({
      pool,
      intent,
      agentSig: normalizeHex(agentSig),
      sequencerKeyId: 'seq-key-1',
      sequencerPrivateKey,
      leafSaltSecret: LEAF_SALT_SECRET,
      executionGraceSeconds: EXECUTION_GRACE_SECONDS,
      supportedChainRefs: new Set([chainRef])
    });

    await new Promise((resolve) => setTimeout(resolve, 2100));

    const reclaimPayload = {
      authId: authorizeResponse.authorization.authId,
      callerType: 'agent' as const,
      agentId,
      requestedAt: nowSeconds().toString()
    };
    const reclaimSig = await account.signTypedData(buildReclaimTypedDataPayload(reclaimPayload));
    const reclaimResponse = await reclaimAuthorization({
      pool,
      request: {
        ...reclaimPayload,
        agentSig: normalizeHex(reclaimSig)
      },
      adminTokenHeader: undefined,
      expectedAdminToken: undefined
    });

    expect(reclaimResponse.ok).toBe(true);
    expect(reclaimResponse.authId).toBe(authorizeResponse.authorization.authId);
  });
});
