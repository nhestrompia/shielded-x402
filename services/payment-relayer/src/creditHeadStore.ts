import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CreditState, Hex } from '@shielded-x402/shared-types';
import type { CreditChannelHeadStore } from './types.js';

interface CreditHeadStoreData {
  heads: Record<string, CreditState>;
}

const EMPTY_DATA: CreditHeadStoreData = {
  heads: {}
};

function normalizeChannelId(channelId: Hex): string {
  return channelId.toLowerCase();
}

export class FileCreditChannelHeadStore implements CreditChannelHeadStore {
  private data: CreditHeadStoreData | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(channelId: Hex): Promise<CreditState | undefined> {
    await this.ensureLoaded();
    return this.data?.heads[normalizeChannelId(channelId)];
  }

  async put(state: CreditState): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.data) {
        this.data = { heads: {} };
      }
      this.data.heads[normalizeChannelId(state.channelId)] = state;
      await this.persist();
    });
  }

  async delete(channelId: Hex): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.data) {
        this.data = { heads: {} };
      }
      delete this.data.heads[normalizeChannelId(channelId)];
      await this.persist();
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw) as CreditHeadStoreData;
    } catch {
      this.data = {
        heads: { ...EMPTY_DATA.heads }
      };
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }

  private async enqueue(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(action, action);
    await this.queue;
  }
}
