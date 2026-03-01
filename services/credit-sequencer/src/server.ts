import express from 'express';
import type { Hex } from '@shielded-x402/shared-types';
import { normalizeHex } from '@shielded-x402/shared-types';
import { Pool } from 'pg';
import { createPublicKey } from 'node:crypto';
import {
  parseSequencerPrivateKey,
  parseSupportedChainRefs
} from './lib.js';
import {
  extractEd25519RawPublicKey,
  createEd25519PrivateKeyFromSeed
} from './crypto.js';
import { reclaimAuthorization } from './services/ledger.js';
import { runCommitmentEpoch } from './services/commitments.js';
import {
  parseRelayerKeysEnv,
  seedRelayerKeys
} from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { registerSequencerRoutes } from './http/routes.js';

const ZERO_HASH = (`0x${'00'.repeat(32)}` as Hex);

const metrics = {
  authorizationLatencyMs: [] as number[],
  executionReportConflictsTotal: 0,
  expiredReclaimsTotal: 0
};

function recordAuthorizationLatency(ms: number): void {
  metrics.authorizationLatencyMs.push(ms);
  if (metrics.authorizationLatencyMs.length > 200) {
    metrics.authorizationLatencyMs.shift();
  }
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function sweepExpiredAuthorizations(input: {
  pool: Pool;
  adminToken: string | undefined;
}): Promise<number> {
  const now = nowSeconds().toString();
  const expired = await input.pool.query<{ auth_id: string }>(
    `SELECT auth_id
     FROM authorizations
     WHERE status = 'ISSUED' AND expires_at < $1
     ORDER BY expires_at ASC
     LIMIT 200`,
    [now]
  );
  let reclaimed = 0;
  for (const row of expired.rows) {
    try {
      await reclaimAuthorization({
        pool: input.pool,
        request: {
          authId: normalizeHex(row.auth_id),
          callerType: 'sequencer',
          requestedAt: now
        },
        adminTokenHeader: input.adminToken,
        expectedAdminToken: input.adminToken,
        allowInternalSequencer: true
      });
      reclaimed += 1;
      metrics.expiredReclaimsTotal += 1;
    } catch (error) {
      // Best effort sweep; leave detailed reclaim validation to normal API calls.
      console.warn('[sequencer] reclaim sweep skipped auth', row.auth_id, error);
    }
  }
  return reclaimed;
}

async function main(): Promise<void> {
  const port = Number(process.env.SEQUENCER_PORT ?? '3201');
  const databaseUrl = process.env.SEQUENCER_DATABASE_URL;
  const sequencerKeyId = process.env.SEQUENCER_SIGNING_KEY_ID ?? 'seq-key-1';
  const sequencerPrivateKeyRaw = process.env.SEQUENCER_SIGNING_PRIVATE_KEY;
  const leafSaltSecret = (process.env.SEQUENCER_LEAF_SALT_SECRET ??
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') as Hex;
  const executionGraceSeconds = BigInt(process.env.SEQUENCER_EXECUTION_GRACE_SECONDS ?? '300');
  const epochSeconds = Number(process.env.SEQUENCER_EPOCH_SECONDS ?? '3600');
  const adminToken = process.env.SEQUENCER_ADMIN_TOKEN;
  const supportedChainRefs = parseSupportedChainRefs(process.env.SEQUENCER_SUPPORTED_CHAIN_REFS);
  const relayerKeys = parseRelayerKeysEnv(process.env.SEQUENCER_RELAYER_KEYS_JSON);
  const baseRegistryAddress = process.env.SEQUENCER_BASE_REGISTRY_ADDRESS as Hex | undefined;
  const basePosterPrivateKey = process.env.SEQUENCER_BASE_POSTER_PRIVATE_KEY as Hex | undefined;
  const baseRpcUrl = process.env.SEQUENCER_BASE_RPC_URL;
  const sweeperSeconds = Number(process.env.SEQUENCER_SWEEPER_SECONDS ?? '30');

  if (!databaseUrl) throw new Error('SEQUENCER_DATABASE_URL is required');
  if (!sequencerPrivateKeyRaw) throw new Error('SEQUENCER_SIGNING_PRIVATE_KEY is required');
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizeHex(leafSaltSecret))) {
    throw new Error('SEQUENCER_LEAF_SALT_SECRET must be 32-byte hex');
  }

  const sequencerPrivateSeed = parseSequencerPrivateKey(sequencerPrivateKeyRaw);
  const sequencerPrivateKey = createEd25519PrivateKeyFromSeed(sequencerPrivateSeed);
  const sequencerPublicKey = extractEd25519RawPublicKey(
    createPublicKey(sequencerPrivateKey)
  );

  const pool = new Pool({
    connectionString: databaseUrl
  });
  await runMigrations(databaseUrl);
  await seedRelayerKeys(pool, relayerKeys);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  registerSequencerRoutes({
    app,
    pool,
    zeroHash: ZERO_HASH,
    sequencerKeyId,
    sequencerPublicKey,
    executionGraceSeconds,
    epochSeconds,
    supportedChainRefs,
    adminToken,
    sequencerPrivateKey,
    leafSaltSecret: normalizeHex(leafSaltSecret),
    baseRegistryAddress,
    basePosterPrivateKey,
    baseRpcUrl,
    metrics,
    recordAuthorizationLatency
  });

  const commitmentInterval = setInterval(() => {
    runCommitmentEpoch({
      pool,
      sequencerKeyId,
      baseRegistryAddress,
      basePosterPrivateKey,
      baseRpcUrl
    }).catch((error) => {
      console.error('[sequencer] commitment loop error', error);
    });
  }, Math.max(1, epochSeconds) * 1000);

  const sweeperInterval = setInterval(() => {
    sweepExpiredAuthorizations({
      pool,
      adminToken
    }).catch((error) => {
      console.error('[sequencer] reclaim sweep error', error);
    });
  }, Math.max(1, sweeperSeconds) * 1000);

  const server = app.listen(port, () => {
    console.log(`[credit-sequencer] listening on ${port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[credit-sequencer] ${signal} received, shutting down`);
    clearInterval(commitmentInterval);
    clearInterval(sweeperInterval);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void main();
