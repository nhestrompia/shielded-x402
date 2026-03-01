import type express from 'express';
import type { KeyObject } from 'node:crypto';
import type { Pool } from 'pg';
import { normalizeHex } from '@shielded-x402/shared-types';
import type { Hex } from '@shielded-x402/shared-types';
import { errorCodeFromMessage } from '../lib.js';
import {
  parseAdminCreditRequest,
  parseAuthorizeRequest,
  parseExecutionReport,
  parseReclaimRequest
} from '../validation.js';
import {
  authorizeIntent,
  reclaimAuthorization,
  recordExecution,
  withTx
} from '../services/ledger.js';
import {
  buildInclusionProof,
  runCommitmentEpoch
} from '../services/commitments.js';

export interface SequencerMetricsView {
  authorizationLatencyMs: number[];
  executionReportConflictsTotal: number;
  expiredReclaimsTotal: number;
}

export interface SequencerRouteDeps {
  app: express.Express;
  pool: Pool;
  zeroHash: Hex;
  sequencerKeyId: string;
  sequencerPublicKey: Hex;
  executionGraceSeconds: bigint;
  epochSeconds: number;
  supportedChainRefs: Set<string>;
  adminToken: string | undefined;
  sequencerPrivateKey: KeyObject;
  leafSaltSecret: Hex;
  baseRegistryAddress: Hex | undefined;
  basePosterPrivateKey: Hex | undefined;
  baseRpcUrl: string | undefined;
  metrics: SequencerMetricsView;
  recordAuthorizationLatency: (ms: number) => void;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function registerSequencerRoutes(deps: SequencerRouteDeps): void {
  const {
    app,
    pool,
    zeroHash,
    sequencerKeyId,
    sequencerPublicKey,
    executionGraceSeconds,
    epochSeconds,
    supportedChainRefs,
    adminToken,
    sequencerPrivateKey,
    leafSaltSecret,
    baseRegistryAddress,
    basePosterPrivateKey,
    baseRpcUrl,
    metrics,
    recordAuthorizationLatency
  } = deps;

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'credit-sequencer',
      sequencerKeyId
    });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      const [dbPing, keyCount, latestCommit] = await Promise.all([
        pool.query('SELECT 1 AS ok'),
        pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM relayer_keys WHERE status = 'ACTIVE'`),
        pool.query<{
          epoch_id: string;
          root: string;
          posted_at: string | null;
          posted_tx_hash: string | null;
        }>(
          `SELECT epoch_id, root, posted_at, posted_tx_hash
           FROM commitments
           ORDER BY epoch_id DESC
           LIMIT 1`
        )
      ]);

      const latest = latestCommit.rows[0];
      const relayerKeyCount = Number(keyCount.rows[0]?.count ?? '0');
      const ready = dbPing.rowCount === 1 && relayerKeyCount > 0;
      res.status(ready ? 200 : 503).json({
        ok: ready,
        sequencerKeyId,
        sequencerPublicKey,
        executionGraceSeconds: executionGraceSeconds.toString(),
        epochSeconds,
        supportedChainRefs: [...supportedChainRefs],
        relayerKeyCount,
        latestCommitment: latest
          ? {
              epochId: latest.epoch_id,
              root: normalizeHex(latest.root),
              postedAt: latest.posted_at,
              postedTxHash: latest.posted_tx_hash
            }
          : null
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/metrics', async (_req, res) => {
    const latest = await pool.query<{ posted_at: string | null }>(
      `SELECT posted_at
       FROM commitments
       ORDER BY epoch_id DESC
       LIMIT 1`
    );
    const postedAt = latest.rows[0]?.posted_at ? BigInt(latest.rows[0].posted_at) : undefined;
    const lag = postedAt ? Number(nowSeconds() - postedAt) : null;
    res.json({
      authorization_latency_ms_avg: average(metrics.authorizationLatencyMs),
      execution_report_conflicts_total: metrics.executionReportConflictsTotal,
      expired_reclaims_total: metrics.expiredReclaimsTotal,
      commitment_lag_seconds: lag
    });
  });

  app.post('/v1/admin/credit', async (req, res) => {
    try {
      if (!adminToken || req.header('x-sequencer-admin-token') !== adminToken) {
        res.status(401).json({ error: 'unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      const { agentId, amountMicros } = parseAdminCreditRequest(req.body);

      await withTx(pool, async (client) => {
        const now = nowSeconds();
        await client.query(
          `INSERT INTO agents(agent_id, balance_micros, next_agent_nonce, credited_micros, debited_outstanding_micros, updated_at, agent_pub_key, signature_scheme)
           VALUES ($1, $2, 0, $2, 0, $3, NULL, NULL)
           ON CONFLICT (agent_id)
           DO UPDATE SET
             balance_micros = agents.balance_micros + $2,
             credited_micros = agents.credited_micros + $2,
             updated_at = $3`,
          [agentId, amountMicros.toString(), now.toString()]
        );
      });

      res.json({ ok: true, agentId, creditedMicros: amountMicros.toString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });

  app.post('/v1/credit/authorize', async (req, res) => {
    try {
      const payload = parseAuthorizeRequest(req.body);
      const startedAt = Date.now();
      const response = await authorizeIntent({
        pool,
        intent: payload.intent,
        agentSig: normalizeHex(payload.agentSig),
        sequencerKeyId,
        sequencerPrivateKey,
        leafSaltSecret: normalizeHex(leafSaltSecret),
        executionGraceSeconds,
        supportedChainRefs
      });
      recordAuthorizationLatency(Date.now() - startedAt);
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(422).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });

  app.post('/v1/credit/executions', async (req, res) => {
    try {
      const report = parseExecutionReport(req.body);
      const result = await recordExecution({
        pool,
        report,
        onExecutionConflict: () => {
          metrics.executionReportConflictsTotal += 1;
        }
      });
      res.json({ ok: true, idempotent: result.idempotent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('UNAUTHORIZED_REPORTER') ? 401 : 422;
      res.status(status).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });

  app.post('/v1/credit/reclaim', async (req, res) => {
    try {
      const reclaimReq = parseReclaimRequest(req.body);
      const result = await reclaimAuthorization({
        pool,
        request: reclaimReq,
        adminTokenHeader: req.header('x-sequencer-admin-token') ?? undefined,
        expectedAdminToken: adminToken
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(422).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });

  app.get('/v1/commitments/latest', async (_req, res) => {
    const latest = await pool.query<{
      epoch_id: string;
      root: string;
      count: number;
      prev_root: string;
      sequencer_key_id: string;
      posted_at: string | null;
      posted_tx_hash: string | null;
    }>(
      `SELECT epoch_id, root, count, prev_root, sequencer_key_id, posted_at, posted_tx_hash
       FROM commitments
       ORDER BY epoch_id DESC
       LIMIT 1`
    );
    const row = latest.rows[0];
    if (!row) {
      res.json({
        latestEpochId: '0',
        root: zeroHash,
        postedAt: null
      });
      return;
    }
    res.json({
      latestEpochId: row.epoch_id,
      root: normalizeHex(row.root),
      count: row.count,
      prevRoot: normalizeHex(row.prev_root),
      sequencerKeyId: row.sequencer_key_id,
      postedAt: row.posted_at,
      postedTxHash: row.posted_tx_hash
    });
  });

  app.get('/v1/commitments/proof', async (req, res) => {
    try {
      const authId = normalizeHex(String(req.query.authId ?? ''));
      const proof = await buildInclusionProof({
        pool,
        authId,
        leafSaltSecret: normalizeHex(leafSaltSecret)
      });
      res.json(proof);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });

  app.post('/v1/commitments/run', async (_req, res) => {
    try {
      const result = await runCommitmentEpoch({
        pool,
        sequencerKeyId,
        baseRegistryAddress,
        basePosterPrivateKey,
        baseRpcUrl
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message, code: errorCodeFromMessage(message) });
    }
  });
}
