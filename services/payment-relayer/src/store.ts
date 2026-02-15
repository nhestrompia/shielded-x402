import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SettlementRecord, SettlementStore } from './types.js';

interface StoreData {
  bySettlementId: Record<string, SettlementRecord>;
  byIdempotencyKey: Record<string, string>;
}

const EMPTY_DATA: StoreData = {
  bySettlementId: {},
  byIdempotencyKey: {}
};

export class FileSettlementStore implements SettlementStore {
  private data: StoreData | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getBySettlementId(settlementId: string): Promise<SettlementRecord | undefined> {
    await this.ensureLoaded();
    return this.data?.bySettlementId[settlementId];
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<SettlementRecord | undefined> {
    await this.ensureLoaded();
    const settlementId = this.data?.byIdempotencyKey[idempotencyKey];
    if (!settlementId) return undefined;
    return this.data?.bySettlementId[settlementId];
  }

  async put(record: SettlementRecord): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.data) {
        this.data = {
          bySettlementId: {},
          byIdempotencyKey: {}
        };
      }
      this.data.bySettlementId[record.settlementId] = record;
      this.data.byIdempotencyKey[record.idempotencyKey] = record.settlementId;
      await this.persist();
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw) as StoreData;
    } catch {
      this.data = {
        bySettlementId: { ...EMPTY_DATA.bySettlementId },
        byIdempotencyKey: { ...EMPTY_DATA.byIdempotencyKey }
      };
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const raw = JSON.stringify(this.data, null, 2);
    await writeFile(tempPath, raw, 'utf8');
    await rename(tempPath, this.filePath);
  }

  private async enqueue(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(action, action);
    await this.queue;
  }
}
