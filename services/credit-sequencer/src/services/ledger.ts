import {
  buildReclaimTypedDataPayload,
  buildIntentTypedDataPayload,
  canonicalExecutionReportBytes,
  canonicalIntentBytes,
  canonicalReclaimRequestBytes,
  computeAuthorizationLeaf,
  deriveAgentIdFromPubKey,
  deriveAuthorizationId,
  deriveLeafSalt,
  hashAuthorization,
  hashIntent,
  normalizeHex,
  type AuthorizationStatus,
  type AuthorizationV1,
  type AuthorizeResponseV1,
  type ExecutionReportV1,
  type Hex,
  type IntentV1,
  type ReclaimRequestV1
} from '@shielded-x402/shared-types';
import { type KeyObject } from 'node:crypto';
import { type Pool, type PoolClient } from 'pg';
import {
  recoverTypedDataAddressRuntime,
  sha256,
  signAuthorization,
  verifyEd25519Signature
} from '../crypto.js';
import { normalizeExecutionTxHash, parseUint64 } from '../validation.js';

interface DbAuthorizationRow {
  auth_id: Hex;
  request_id: Hex;
  intent_hash: Hex;
  authorization_json: AuthorizationV1;
  sequencer_sig: Hex;
  status: AuthorizationStatus;
  expires_at: string;
  execution_grace_until: string;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function verifyIntentSignature(intent: IntentV1, agentSig: Hex): Promise<void> {
  const expectedAgentId = deriveAgentIdFromPubKey(intent.agentPubKey);
  if (normalizeHex(intent.agentId) !== normalizeHex(expectedAgentId)) {
    throw new Error('agentId does not match agentPubKey');
  }

  if (intent.signatureScheme === 'ed25519-sha256-v1') {
    const messageHash = sha256(canonicalIntentBytes(intent));
    const valid = verifyEd25519Signature({
      messageHash,
      signature: agentSig,
      publicKey: intent.agentPubKey
    });
    if (!valid) {
      throw new Error('invalid ed25519 agent signature');
    }
    return;
  }

  if (intent.signatureScheme === 'eip712-secp256k1') {
    const payload = buildIntentTypedDataPayload(intent);
    const recovered = await recoverTypedDataAddressRuntime({
      ...payload,
      signature: agentSig
    });
    const recoveredLower = recovered.toLowerCase();
    const pubAsAddress = normalizeHex(intent.agentPubKey).toLowerCase();
    if (recoveredLower !== pubAsAddress) {
      throw new Error('invalid EIP-712 agent signature');
    }
    return;
  }

  throw new Error(`unsupported signature scheme: ${intent.signatureScheme}`);
}

function verifyExecutionReportSignature(input: {
  report: ExecutionReportV1;
  relayerPublicKey: Hex;
}): void {
  const messageHash = sha256(
    canonicalExecutionReportBytes({
      authId: input.report.authId,
      chainRef: input.report.chainRef,
      executionTxHash: input.report.executionTxHash,
      status: input.report.status,
      reportId: input.report.reportId,
      reportedAt: input.report.reportedAt,
      relayerKeyId: input.report.relayerKeyId
    })
  );
  const valid = verifyEd25519Signature({
    messageHash,
    signature: input.report.reportSig,
    publicKey: input.relayerPublicKey
  });
  if (!valid) {
    throw new Error('invalid execution report signature');
  }
}

async function verifyAgentReclaimSignature(input: {
  poolClient: PoolClient;
  request: ReclaimRequestV1;
  authAgentId: Hex;
}): Promise<void> {
  if (!input.request.agentId || !input.request.agentSig) {
    throw new Error('agentId and agentSig are required for agent reclaim');
  }
  if (normalizeHex(input.request.agentId) !== normalizeHex(input.authAgentId)) {
    throw new Error('agent reclaim caller mismatch');
  }
  const agentRes = await input.poolClient.query<{
    agent_pub_key: string | null;
    signature_scheme: IntentV1['signatureScheme'] | null;
  }>(
    `SELECT agent_pub_key, signature_scheme
     FROM agents
     WHERE agent_id = $1
     FOR UPDATE`,
    [input.authAgentId]
  );
  const agent = agentRes.rows[0];
  if (!agent?.agent_pub_key || !agent.signature_scheme) {
    throw new Error('agent signing metadata missing');
  }
  if (agent.signature_scheme === 'ed25519-sha256-v1') {
    const messageHash = sha256(
      canonicalReclaimRequestBytes({
        authId: input.request.authId,
        callerType: input.request.callerType,
        agentId: input.request.agentId,
        requestedAt: input.request.requestedAt
      })
    );
    const valid = verifyEd25519Signature({
      messageHash,
      signature: input.request.agentSig,
      publicKey: normalizeHex(agent.agent_pub_key)
    });
    if (!valid) {
      throw new Error('invalid agent reclaim signature');
    }
    return;
  }

  if (agent.signature_scheme === 'eip712-secp256k1') {
    const payload = buildReclaimTypedDataPayload({
      authId: input.request.authId,
      callerType: input.request.callerType,
      agentId: input.request.agentId,
      requestedAt: input.request.requestedAt
    });
    const recovered = await recoverTypedDataAddressRuntime({
      ...payload,
      signature: input.request.agentSig
    });
    const expected = normalizeHex(agent.agent_pub_key).toLowerCase();
    if (recovered.toLowerCase() !== expected) {
      throw new Error('invalid agent reclaim signature');
    }
    return;
  }

  throw new Error(`unsupported agent signature scheme for reclaim: ${agent.signature_scheme}`);
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authorizeIntent(input: {
  pool: Pool;
  intent: IntentV1;
  agentSig: Hex;
  sequencerKeyId: string;
  sequencerPrivateKey: KeyObject;
  leafSaltSecret: Hex;
  executionGraceSeconds: bigint;
  supportedChainRefs: Set<string>;
}): Promise<AuthorizeResponseV1> {
  const now = nowSeconds();
  const intentExpiry = parseUint64(input.intent.expiresAt, 'intent.expiresAt');
  if (now > intentExpiry) {
    throw new Error('intent expired');
  }
  if (!input.supportedChainRefs.has(input.intent.requiredChainRef)) {
    throw new Error(`unsupported requiredChainRef: ${input.intent.requiredChainRef}`);
  }
  await verifyIntentSignature(input.intent, input.agentSig);

  const requestId = normalizeHex(input.intent.requestId);
  const intentHash = hashIntent(input.intent);

  return withTx(input.pool, async (client) => {
    await client.query(
      `INSERT INTO agents(agent_id, updated_at)
       VALUES ($1, $2)
       ON CONFLICT (agent_id) DO NOTHING`,
      [input.intent.agentId, now.toString()]
    );

    const agentRow = await client.query<{
      balance_micros: string;
      next_agent_nonce: string;
      credited_micros: string;
      debited_outstanding_micros: string;
      agent_pub_key: string | null;
      signature_scheme: IntentV1['signatureScheme'] | null;
    }>(
      `SELECT balance_micros, next_agent_nonce, credited_micros, debited_outstanding_micros, agent_pub_key, signature_scheme
       FROM agents
       WHERE agent_id = $1
       FOR UPDATE`,
      [input.intent.agentId]
    );
    const agent = agentRow.rows[0];
    if (!agent) {
      throw new Error('agent account not found');
    }
    if (
      agent.agent_pub_key &&
      normalizeHex(agent.agent_pub_key) !== normalizeHex(input.intent.agentPubKey)
    ) {
      throw new Error('agentPubKey mismatch for existing agent');
    }
    if (agent.signature_scheme && agent.signature_scheme !== input.intent.signatureScheme) {
      throw new Error('signatureScheme mismatch for existing agent');
    }

    const idem = await client.query<{ request_id: string; intent_hash: string; auth_id: string }>(
      `SELECT request_id, intent_hash, auth_id
       FROM idempotency_keys
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId]
    );

    if (idem.rowCount && idem.rows[0]) {
      const idemRow = idem.rows[0];
      if (normalizeHex(idemRow.intent_hash) !== normalizeHex(intentHash)) {
        throw new Error('requestId already used for a different intent');
      }
      const existing = await client.query<DbAuthorizationRow>(
        `SELECT auth_id, request_id, intent_hash, authorization_json, sequencer_sig, status, expires_at, execution_grace_until
         FROM authorizations
         WHERE auth_id = $1
         FOR UPDATE`,
        [idemRow.auth_id]
      );
      const row = existing.rows[0];
      if (!row) throw new Error('idempotency record points to missing authorization');
      return {
        authorization: row.authorization_json,
        sequencerSig: normalizeHex(row.sequencer_sig),
        idempotent: true
      };
    }

    const expectedNonce = BigInt(agent.next_agent_nonce);
    const incomingNonce = parseUint64(input.intent.agentNonce, 'intent.agentNonce');
    if (incomingNonce !== expectedNonce) {
      throw new Error(`invalid agent nonce: expected ${expectedNonce}, received ${incomingNonce}`);
    }

    const amountMicros = parseUint64(input.intent.amountMicros, 'intent.amountMicros');
    if (amountMicros <= 0n) {
      throw new Error('amountMicros must be > 0');
    }
    const balance = BigInt(agent.balance_micros);
    if (balance < amountMicros) {
      throw new Error('insufficient sequencer balance');
    }

    const countersRes = await client.query<{
      log_seq_no: string;
      last_leaf_hash: string;
      last_epoch_id: string;
    }>(
      `SELECT log_seq_no, last_leaf_hash, last_epoch_id
       FROM sequencer_counters
       WHERE singleton = TRUE
       FOR UPDATE`
    );
    const counters = countersRes.rows[0];
    if (!counters) {
      throw new Error('sequencer counters missing');
    }

    const nextSeq = BigInt(counters.log_seq_no) + 1n;
    const epochHint = BigInt(counters.last_epoch_id) + 1n;
    const intentId = intentHash;
    const authId = deriveAuthorizationId({
      intentId,
      sequencerEpoch: epochHint.toString(),
      seqNo: nextSeq.toString()
    });

    const authorization: AuthorizationV1 = {
      version: 1,
      intentId,
      authId,
      authorizedAmountMicros: amountMicros.toString(),
      agentId: normalizeHex(input.intent.agentId),
      agentNonce: incomingNonce.toString(),
      merchantId: normalizeHex(input.intent.merchantId),
      chainRef: input.intent.requiredChainRef,
      issuedAt: now.toString(),
      expiresAt: intentExpiry.toString(),
      sequencerEpochHint: epochHint.toString(),
      logSeqNo: nextSeq.toString(),
      sequencerKeyId: input.sequencerKeyId
    };

    const sequencerSig = signAuthorization(input.sequencerPrivateKey, authorization);
    const authHash = hashAuthorization(authorization);
    const prevLeafHash = normalizeHex(counters.last_leaf_hash);
    const salt = deriveLeafSalt(input.leafSaltSecret, authId);
    const leafHash = computeAuthorizationLeaf({
      logSeqNo: authorization.logSeqNo,
      prevLeafHash,
      authHash,
      salt
    });

    const graceUntil = intentExpiry + input.executionGraceSeconds;
    await client.query(
      `INSERT INTO authorizations(
         auth_id, request_id, intent_hash, agent_id, agent_nonce, amount_micros, merchant_id, chain_ref,
         issued_at, expires_at, execution_grace_until, log_seq_no, status, sequencer_key_id, sequencer_sig, authorization_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, 'ISSUED', $13, $14, $15
       )`,
      [
        authId,
        requestId,
        intentHash,
        input.intent.agentId,
        authorization.agentNonce,
        authorization.authorizedAmountMicros,
        input.intent.merchantId,
        authorization.chainRef,
        authorization.issuedAt,
        authorization.expiresAt,
        graceUntil.toString(),
        authorization.logSeqNo,
        input.sequencerKeyId,
        sequencerSig,
        JSON.stringify(authorization)
      ]
    );

    await client.query(
      `INSERT INTO idempotency_keys(request_id, intent_hash, auth_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [requestId, intentHash, authId, now.toString()]
    );

    await client.query(
      `INSERT INTO auth_leaves(log_seq_no, auth_id, prev_leaf_hash, leaf_hash)
       VALUES ($1, $2, $3, $4)`,
      [authorization.logSeqNo, authId, prevLeafHash, leafHash]
    );

    const updatedBalance = balance - amountMicros;
    const creditedMicros = BigInt(agent.credited_micros);
    const debitedOutstanding = BigInt(agent.debited_outstanding_micros) + amountMicros;
    if (debitedOutstanding > creditedMicros) {
      throw new Error('protocol invariant violated: debited exceeds credited');
    }

    await client.query(
      `UPDATE agents
       SET balance_micros = $2,
           next_agent_nonce = $3,
           debited_outstanding_micros = $4,
           agent_pub_key = COALESCE(agent_pub_key, $6),
           signature_scheme = COALESCE(signature_scheme, $7),
           updated_at = $5
       WHERE agent_id = $1`,
      [
        input.intent.agentId,
        updatedBalance.toString(),
        (incomingNonce + 1n).toString(),
        debitedOutstanding.toString(),
        now.toString(),
        input.intent.agentPubKey,
        input.intent.signatureScheme
      ]
    );

    await client.query(
      `UPDATE sequencer_counters
       SET log_seq_no = $1, last_leaf_hash = $2
       WHERE singleton = TRUE`,
      [authorization.logSeqNo, leafHash]
    );

    return {
      authorization,
      sequencerSig,
      idempotent: false
    };
  });
}

export async function recordExecution(input: {
  pool: Pool;
  report: ExecutionReportV1;
  onExecutionConflict?: () => void;
}): Promise<{ ok: true; idempotent: boolean }> {
  const now = nowSeconds();
  return withTx(input.pool, async (client) => {
    const reportAt = parseUint64(input.report.reportedAt, 'report.reportedAt');
    if (reportAt > now + 300n) {
      throw new Error('execution report reportedAt too far in the future');
    }

    const authRes = await client.query<{
      status: AuthorizationStatus;
      chain_ref: string;
      execution_grace_until: string;
      auth_id: string;
    }>(
      `SELECT status, chain_ref, execution_grace_until, auth_id
       FROM authorizations
       WHERE auth_id = $1
       FOR UPDATE`,
      [input.report.authId]
    );
    const auth = authRes.rows[0];
    if (!auth) throw new Error('authorization not found');

    if (input.report.chainRef !== auth.chain_ref) {
      throw new Error('execution chainRef mismatch');
    }

    const relayerKeyRes = await client.query<{ public_key: string; status: string }>(
      `SELECT public_key, status
       FROM relayer_keys
       WHERE chain_ref = $1 AND key_id = $2
       FOR UPDATE`,
      [input.report.chainRef, input.report.relayerKeyId]
    );
    const relayerKey = relayerKeyRes.rows[0];
    if (!relayerKey || relayerKey.status !== 'ACTIVE') {
      throw new Error(
        `UNAUTHORIZED_REPORTER chainRef=${input.report.chainRef} relayerKeyId=${input.report.relayerKeyId}`
      );
    }
    verifyExecutionReportSignature({
      report: input.report,
      relayerPublicKey: normalizeHex(relayerKey.public_key)
    });

    const existingAttempt = await client.query<{
      report_id: string;
      tx_hash: string;
      status: string;
    }>(
      `SELECT report_id, tx_hash, status
       FROM execution_attempts
       WHERE report_id = $1
       FOR UPDATE`,
      [input.report.reportId]
    );
    if (existingAttempt.rowCount && existingAttempt.rows[0]) {
      const attempt = existingAttempt.rows[0];
      if (
        normalizeExecutionTxHash(attempt.tx_hash) ===
          normalizeExecutionTxHash(input.report.executionTxHash) &&
        attempt.status === input.report.status
      ) {
        return { ok: true as const, idempotent: true };
      }
      throw new Error('reportId already used with different execution payload');
    }

    await client.query(
      `INSERT INTO execution_attempts(auth_id, report_id, tx_hash, status, reporter_key_id, reported_at, report_sig)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.report.authId,
        input.report.reportId,
        input.report.executionTxHash,
        input.report.status,
        input.report.relayerKeyId,
        reportAt.toString(),
        input.report.reportSig
      ]
    );

    if (auth.status === 'RECLAIMED') {
      throw new Error('authorization already reclaimed');
    }
    if (auth.status !== 'ISSUED' && auth.status !== 'EXECUTED') {
      throw new Error(`invalid authorization status transition: ${auth.status}`);
    }
    if (now > BigInt(auth.execution_grace_until)) {
      throw new Error('execution report beyond grace window');
    }

    if (input.report.status === 'FAILED') {
      return { ok: true as const, idempotent: false };
    }

    const existingExecution = await client.query<{
      execution_tx_hash: string;
    }>(
      `SELECT execution_tx_hash
       FROM executions
       WHERE auth_id = $1
       FOR UPDATE`,
      [input.report.authId]
    );

    if (existingExecution.rowCount && existingExecution.rows[0]) {
      const previousTxHash = normalizeExecutionTxHash(existingExecution.rows[0].execution_tx_hash);
      const incomingTxHash = normalizeExecutionTxHash(input.report.executionTxHash);
      if (previousTxHash === incomingTxHash) {
        return { ok: true as const, idempotent: true };
      }
      input.onExecutionConflict?.();
      throw new Error('CONFLICT_EXECUTION for authId');
    }

    if (auth.status === 'EXECUTED') {
      throw new Error('authorization already executed with missing execution record');
    }

    await client.query(
      `INSERT INTO executions(auth_id, chain_ref, execution_tx_hash, status, relayer_key_id, reported_at)
       VALUES ($1, $2, $3, 'SUCCESS', $4, $5)`,
      [
        input.report.authId,
        input.report.chainRef,
        input.report.executionTxHash,
        input.report.relayerKeyId,
        reportAt.toString()
      ]
    );

    if (auth.status === 'ISSUED') {
      await client.query(
        `UPDATE authorizations
         SET status = 'EXECUTED', executed_at = $2
         WHERE auth_id = $1`,
        [input.report.authId, now.toString()]
      );
    }

    return { ok: true as const, idempotent: false };
  });
}

export async function reclaimAuthorization(input: {
  pool: Pool;
  request: ReclaimRequestV1;
  adminTokenHeader: string | undefined;
  expectedAdminToken: string | undefined;
  allowInternalSequencer?: boolean;
}): Promise<{ ok: true; authId: Hex }> {
  const now = nowSeconds();
  const requestedAt = parseUint64(input.request.requestedAt, 'request.requestedAt');
  if (requestedAt > now + 300n) {
    throw new Error('reclaim requestedAt too far in the future');
  }
  return withTx(input.pool, async (client) => {
    const authRes = await client.query<{
      auth_id: string;
      status: AuthorizationStatus;
      expires_at: string;
      amount_micros: string;
      agent_id: string;
      reclaimed_at: string | null;
    }>(
      `SELECT auth_id, status, expires_at, amount_micros, agent_id, reclaimed_at
       FROM authorizations
       WHERE auth_id = $1
       FOR UPDATE`,
      [input.request.authId]
    );
    const auth = authRes.rows[0];
    if (!auth) throw new Error('authorization not found');

    if (input.request.callerType === 'sequencer') {
      if (
        !input.allowInternalSequencer &&
        (!input.expectedAdminToken || input.adminTokenHeader !== input.expectedAdminToken)
      ) {
        throw new Error('unauthorized sequencer reclaim caller');
      }
    } else if (input.request.callerType === 'agent') {
      await verifyAgentReclaimSignature({
        poolClient: client,
        request: input.request,
        authAgentId: normalizeHex(auth.agent_id)
      });
    } else {
      throw new Error('invalid reclaim callerType');
    }

    if (auth.status !== 'ISSUED') {
      throw new Error('only ISSUED authorizations can be reclaimed');
    }
    if (now <= BigInt(auth.expires_at)) {
      throw new Error('authorization not yet expired');
    }
    if (auth.reclaimed_at) {
      throw new Error('authorization already reclaimed');
    }

    const amount = BigInt(auth.amount_micros);
    const agentRes = await client.query<{
      balance_micros: string;
      debited_outstanding_micros: string;
    }>(
      `SELECT balance_micros, debited_outstanding_micros
       FROM agents
       WHERE agent_id = $1
       FOR UPDATE`,
      [auth.agent_id]
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new Error('agent state missing');

    const balance = BigInt(agent.balance_micros);
    const outstanding = BigInt(agent.debited_outstanding_micros);
    if (outstanding < amount) {
      throw new Error('INVARIANT_VIOLATION outstanding balance lower than reclaim amount');
    }
    const nextOutstanding = outstanding - amount;
    await client.query(
      `UPDATE agents
       SET balance_micros = $2,
           debited_outstanding_micros = $3,
           updated_at = $4
       WHERE agent_id = $1`,
      [auth.agent_id, (balance + amount).toString(), nextOutstanding.toString(), now.toString()]
    );

    await client.query(
      `UPDATE authorizations
       SET status = 'RECLAIMED', reclaimed_at = $2
       WHERE auth_id = $1`,
      [auth.auth_id, now.toString()]
    );

    return { ok: true as const, authId: normalizeHex(auth.auth_id) };
  });
}
