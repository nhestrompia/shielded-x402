import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';

vi.mock(
  '@shielded-x402/shared-types',
  () => ({
    buildIntentTypedDataPayload: () => ({}),
    canonicalExecutionReportBytes: () => Buffer.from([]),
    canonicalIntentBytes: () => Buffer.from([]),
    canonicalReclaimRequestBytes: () => Buffer.from([]),
    computeAuthorizationLeaf: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    deriveAgentIdFromPubKey: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    deriveAuthorizationId: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    deriveLeafSalt: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    hashAuthorization: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    hashIntent: () => ('0x' + '00'.repeat(32)) as `0x${string}`,
    normalizeHex: (value: string) => value.toLowerCase()
  }),
  { virtual: true }
);

vi.mock('../crypto.js', () => ({
  recoverTypedDataAddressRuntime: async () => '0x' + '00'.repeat(20),
  sha256: () => Buffer.from([]),
  signAuthorization: () => ('0x' + '11'.repeat(64)) as `0x${string}`,
  verifyEd25519Signature: () => true
}));

interface MockStep {
  contains: string;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
}

function createMockPool(steps: MockStep[]): Pool {
  let cursor = 0;

  const client = {
    async query(text: string): Promise<QueryResult<any>> {
      const sql = String(text);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 } as QueryResult<any>;
      }
      const step = steps[cursor];
      if (!step) {
        throw new Error(`unexpected query at index ${cursor}: ${sql}`);
      }
      if (!sql.includes(step.contains)) {
        throw new Error(`expected query containing "${step.contains}" but got: ${sql}`);
      }
      cursor += 1;
      const rows = step.rows ?? [];
      return { rows: rows as any[], rowCount: step.rowCount ?? rows.length } as QueryResult<any>;
    },
    release(): void {
      // no-op for test
    }
  } as unknown as PoolClient;

  return {
    async connect(): Promise<PoolClient> {
      return client;
    }
  } as unknown as Pool;
}

let recordExecution: typeof import('./ledger.js').recordExecution;
let reclaimAuthorization: typeof import('./ledger.js').reclaimAuthorization;

beforeAll(async () => {
  const mod = await import('./ledger.js');
  recordExecution = mod.recordExecution;
  reclaimAuthorization = mod.reclaimAuthorization;
});

describe('ledger service', () => {
  it('rejects execution reports from unauthorized relayer key', async () => {
    const pool = createMockPool([
      {
        contains: 'FROM authorizations',
        rows: [
          {
            status: 'ISSUED',
            chain_ref: 'solana:devnet',
            execution_grace_until: '9999999999',
            auth_id: '0x' + '11'.repeat(32)
          }
        ]
      },
      {
        contains: 'FROM relayer_keys',
        rows: []
      }
    ]);

    await expect(
      recordExecution({
        pool,
        report: {
          authId: ('0x' + '11'.repeat(32)) as `0x${string}`,
          chainRef: 'solana:devnet',
          executionTxHash: 'abc123',
          status: 'SUCCESS',
          reportId: ('0x' + '22'.repeat(32)) as `0x${string}`,
          reportedAt: '1',
          relayerKeyId: 'missing-key',
          reportSig: ('0x' + '33'.repeat(64)) as `0x${string}`
        }
      })
    ).rejects.toThrow('UNAUTHORIZED_REPORTER');
  });

  it('hard-fails reclaim when outstanding debit is below authorization amount', async () => {
    const pool = createMockPool([
      {
        contains: 'FROM authorizations',
        rows: [
          {
            auth_id: '0x' + '11'.repeat(32),
            status: 'ISSUED',
            expires_at: '0',
            amount_micros: '100',
            agent_id: '0x' + '44'.repeat(32),
            reclaimed_at: null
          }
        ]
      },
      {
        contains: 'FROM agents',
        rows: [
          {
            balance_micros: '500',
            debited_outstanding_micros: '50'
          }
        ]
      }
    ]);

    await expect(
      reclaimAuthorization({
        pool,
        request: {
          authId: ('0x' + '11'.repeat(32)) as `0x${string}`,
          callerType: 'sequencer',
          requestedAt: '1'
        },
        adminTokenHeader: undefined,
        expectedAdminToken: undefined,
        allowInternalSequencer: true
      })
    ).rejects.toThrow('INVARIANT_VIOLATION outstanding balance lower than reclaim amount');
  });
});
