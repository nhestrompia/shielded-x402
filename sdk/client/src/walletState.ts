import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CreditChannelId,
  Hex,
  RelayerSettlementDelta,
  ShieldedNote,
  SignedCreditState
} from '@shielded-x402/shared-types';
import { normalizeHex } from '@shielded-x402/shared-types';
import { createPublicClient, http, parseAbiItem } from 'viem';
import type { MerkleWitness } from './merkle.js';
import { deriveWitness } from './merkle.js';
import { postJson } from './http.js';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

const depositedEvent = parseAbiItem(
  'event Deposited(bytes32 indexed commitment, uint256 indexed leafIndex, bytes32 indexed root, uint256 amount)'
);

const spentEvent = parseAbiItem(
  'event Spent(bytes32 indexed nullifier, bytes32 indexed merchantCommitment, bytes32 indexed changeCommitment, uint256 amount, bytes32 challengeHash, uint256 merchantLeafIndex, uint256 changeLeafIndex, bytes32 newRoot)'
);
const INDEXER_PAGE_SIZE = 500;

interface IndexerDepositRow {
  id: string;
  commitment: Hex;
  leafIndex: string;
}

interface IndexerSpendRow {
  id: string;
  merchantCommitment: Hex;
  changeCommitment: Hex;
  merchantLeafIndex: string;
  changeLeafIndex: string;
}

interface IndexerEventsRows {
  deposits: IndexerDepositRow[];
  spends: IndexerSpendRow[];
}

interface PersistedNote {
  amount: string;
  rho: Hex;
  pkHash: Hex;
  nullifierSecret: Hex;
  commitment: Hex;
  leafIndex: number;
  depositBlock?: string;
  spent?: boolean;
}

interface PersistedSignedCreditState {
  state: {
    channelId: Hex;
    seq: string;
    available: string;
    cumulativeSpent: string;
    lastDebitDigest: Hex;
    updatedAt: string;
    agentAddress: Hex;
    relayerAddress: Hex;
  };
  agentSignature: Hex;
  relayerSignature: Hex;
}

interface PersistedWalletState {
  version: 3;
  poolAddress: Hex;
  lastSyncedBlock: string;
  commitments: Hex[];
  notes: PersistedNote[];
  creditStates?: Record<string, PersistedSignedCreditState>;
}

export interface WalletNoteRecord extends ShieldedNote {
  nullifierSecret: Hex;
  depositBlock?: bigint;
  spent?: boolean;
}

export interface WalletStateSnapshot {
  poolAddress: Hex;
  lastSyncedBlock: bigint;
  commitments: Hex[];
  notes: WalletNoteRecord[];
}

export interface ShieldedSpendContext {
  note: ShieldedNote;
  witness: MerkleWitness;
  nullifierSecret: Hex;
}

export interface WalletSyncResult {
  fromBlock: bigint;
  toBlock: bigint;
  depositsApplied: number;
  spendsApplied: number;
}

export interface FileBackedWalletStateConfig {
  filePath: string;
  rpcUrl?: string;
  indexerGraphqlUrl?: string;
  shieldedPoolAddress: Hex;
  startBlock?: bigint;
  confirmations?: bigint;
  chunkSize?: bigint;
}

interface InMemoryWalletState {
  lastSyncedBlock: bigint;
  commitments: Hex[];
  notes: WalletNoteRecord[];
  creditStates: Record<string, SignedCreditState>;
}

interface CommitmentWrite {
  blockNumber: bigint;
  logIndex: number;
  order: number;
  leafIndex: number;
  commitment: Hex;
}

function serialize(state: InMemoryWalletState, poolAddress: Hex): PersistedWalletState {
  return {
    version: 3,
    poolAddress,
    lastSyncedBlock: state.lastSyncedBlock.toString(),
    commitments: state.commitments,
    notes: state.notes.map((note) => ({
      amount: note.amount.toString(),
      rho: note.rho,
      pkHash: note.pkHash,
      nullifierSecret: note.nullifierSecret,
      commitment: note.commitment,
      leafIndex: note.leafIndex,
      ...(note.depositBlock !== undefined ? { depositBlock: note.depositBlock.toString() } : {}),
      ...(note.spent !== undefined ? { spent: note.spent } : {})
    })),
    creditStates: Object.fromEntries(
      Object.entries(state.creditStates).map(([channelId, signed]) => [
        channelId,
        {
          state: {
            channelId: signed.state.channelId,
            seq: signed.state.seq,
            available: signed.state.available,
            cumulativeSpent: signed.state.cumulativeSpent,
            lastDebitDigest: signed.state.lastDebitDigest,
            updatedAt: signed.state.updatedAt,
            agentAddress: signed.state.agentAddress,
            relayerAddress: signed.state.relayerAddress
          },
          agentSignature: signed.agentSignature,
          relayerSignature: signed.relayerSignature
        }
      ])
    )
  };
}

function deserialize(payload: PersistedWalletState): InMemoryWalletState {
  const persistedCreditStates = payload.creditStates ?? {};
  const creditStates: Record<string, SignedCreditState> = {};
  for (const [channelId, signed] of Object.entries(persistedCreditStates)) {
    creditStates[channelId] = {
      state: {
        channelId: signed.state.channelId,
        seq: signed.state.seq,
        available: signed.state.available,
        cumulativeSpent: signed.state.cumulativeSpent,
        lastDebitDigest: signed.state.lastDebitDigest,
        updatedAt: signed.state.updatedAt,
        agentAddress: signed.state.agentAddress,
        relayerAddress: signed.state.relayerAddress
      },
      agentSignature: signed.agentSignature,
      relayerSignature: signed.relayerSignature
    };
  }

  return {
    lastSyncedBlock: BigInt(payload.lastSyncedBlock),
    commitments: payload.commitments,
    notes: payload.notes.map((note) => ({
      amount: BigInt(note.amount),
      rho: note.rho,
      pkHash: note.pkHash,
      nullifierSecret: note.nullifierSecret,
      commitment: note.commitment,
      leafIndex: note.leafIndex,
      ...(note.depositBlock !== undefined ? { depositBlock: BigInt(note.depositBlock) } : {}),
      ...(note.spent !== undefined ? { spent: note.spent } : {})
    })),
    creditStates
  };
}

export class FileBackedWalletState {
  private readonly filePath: string;
  private readonly rpcUrl: string | undefined;
  private readonly indexerGraphqlUrl: string | undefined;
  private readonly shieldedPoolAddress: Hex;
  private readonly confirmations: bigint;
  private readonly chunkSize: bigint;
  private readonly startBlock: bigint;
  private indexerFieldNames?: { deposits: string; spends: string };
  private state: InMemoryWalletState;
  private noteIndexesByCommitment: Map<string, number[]>;
  private leafIndexByCommitment: Map<string, number>;

  private constructor(config: FileBackedWalletStateConfig) {
    this.filePath = config.filePath;
    this.rpcUrl = config.rpcUrl;
    this.indexerGraphqlUrl = config.indexerGraphqlUrl;
    this.shieldedPoolAddress = config.shieldedPoolAddress;
    this.confirmations = config.confirmations ?? 2n;
    this.chunkSize = config.chunkSize ?? 2_000n;
    this.startBlock = config.startBlock ?? 0n;
    this.state = {
      lastSyncedBlock: this.startBlock - 1n,
      commitments: [],
      notes: [],
      creditStates: {}
    };
    this.noteIndexesByCommitment = new Map();
    this.leafIndexByCommitment = new Map();
    this.rebuildCommitmentIndexes();
  }

  static async create(config: FileBackedWalletStateConfig): Promise<FileBackedWalletState> {
    const instance = new FileBackedWalletState(config);
    await instance.load();
    return instance;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedWalletState;
      if (parsed.version !== 3) {
        throw new Error(`unsupported wallet state version: ${String(parsed.version)}`);
      }
      if (normalizeHex(parsed.poolAddress) !== normalizeHex(this.shieldedPoolAddress)) {
        throw new Error(
          `wallet state pool mismatch: expected ${this.shieldedPoolAddress}, found ${parsed.poolAddress}`
        );
      }
      this.state = deserialize(parsed);
      this.rebuildCommitmentIndexes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        await this.persist();
        return;
      }
      throw error;
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload = serialize(this.state, this.shieldedPoolAddress);
    await writeFile(this.filePath, JSON.stringify(payload, null, 2));
  }

  snapshot(): WalletStateSnapshot {
    return {
      poolAddress: this.shieldedPoolAddress,
      lastSyncedBlock: this.state.lastSyncedBlock,
      commitments: [...this.state.commitments],
      notes: this.state.notes.map((note) => ({ ...note }))
    };
  }

  getNotes(): WalletNoteRecord[] {
    return this.state.notes.map((note) => ({ ...note }));
  }

  getCreditState(channelId: CreditChannelId): SignedCreditState | undefined {
    const state = this.state.creditStates[channelId.toLowerCase()];
    if (!state) return undefined;
    return {
      state: { ...state.state },
      agentSignature: state.agentSignature,
      relayerSignature: state.relayerSignature
    };
  }

  async setCreditState(signedState: SignedCreditState): Promise<void> {
    this.state.creditStates[signedState.state.channelId.toLowerCase()] = {
      state: { ...signedState.state },
      agentSignature: signedState.agentSignature,
      relayerSignature: signedState.relayerSignature
    };
    await this.persist();
  }

  async clearCreditState(channelId: CreditChannelId): Promise<void> {
    delete this.state.creditStates[channelId.toLowerCase()];
    await this.persist();
  }

  async addOrUpdateNote(note: ShieldedNote, nullifierSecret: Hex, depositBlock?: bigint): Promise<void> {
    const existingIndex = this.findNoteIndexByCommitment(note.commitment);
    const existing = existingIndex >= 0 ? this.state.notes[existingIndex] : undefined;
    const record: WalletNoteRecord = {
      ...note,
      nullifierSecret,
      ...(depositBlock !== undefined ? { depositBlock } : {}),
      ...(existing?.spent !== undefined ? { spent: existing.spent } : {})
    };

    if (existingIndex >= 0) {
      this.state.notes[existingIndex] = record;
    } else {
      this.state.notes.push(record);
    }

    if (record.leafIndex >= 0) {
      this.state.commitments[record.leafIndex] = record.commitment;
    }
    this.rebuildCommitmentIndexes();
    await this.persist();
  }

  async markNoteSpent(commitment: Hex): Promise<boolean> {
    const existingIndex = this.findNoteIndexByCommitment(commitment);
    if (existingIndex < 0) {
      return false;
    }
    const note = this.state.notes[existingIndex];
    if (!note) {
      return false;
    }
    if (note.spent) {
      return true;
    }
    note.spent = true;
    await this.persist();
    return true;
  }

  async recordSpendOutputs(params: {
    merchantCommitment: Hex;
    changeCommitment: Hex;
    merchantLeafIndex?: number;
    changeLeafIndex?: number;
  }): Promise<void> {
    if (params.merchantLeafIndex !== undefined && params.changeLeafIndex !== undefined) {
      this.state.commitments[params.merchantLeafIndex] = params.merchantCommitment;
      this.state.commitments[params.changeLeafIndex] = params.changeCommitment;
    }
    this.rebuildCommitmentIndexes();
    await this.persist();
  }

  async applyRelayerSettlement(params: {
    settlementDelta?: RelayerSettlementDelta;
    changeNote?: ShieldedNote;
    changeNullifierSecret?: Hex;
    spentNoteCommitment?: Hex;
  }): Promise<void> {
    if (params.spentNoteCommitment) {
      await this.markNoteSpent(params.spentNoteCommitment);
    }
    const delta = params.settlementDelta;
    if (!delta) return;

    await this.recordSpendOutputs({
      merchantCommitment: delta.merchantCommitment,
      changeCommitment: delta.changeCommitment,
      ...(delta.merchantLeafIndex !== undefined ? { merchantLeafIndex: delta.merchantLeafIndex } : {}),
      ...(delta.changeLeafIndex !== undefined ? { changeLeafIndex: delta.changeLeafIndex } : {})
    });

    if (params.changeNote) {
      const changeLeafIndex = delta.changeLeafIndex ?? -1;
      if (!params.changeNullifierSecret) {
        throw new Error('applyRelayerSettlement requires changeNullifierSecret when changeNote is provided');
      }
      await this.addOrUpdateNote(
        {
          ...params.changeNote,
          leafIndex: changeLeafIndex
        },
        params.changeNullifierSecret,
        this.state.lastSyncedBlock >= 0n ? this.state.lastSyncedBlock : undefined
      );
    }
  }

  private applyCommitmentWrites(writes: CommitmentWrite[]): void {
    writes.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
      return a.order - b.order;
    });

    for (const write of writes) {
      if (write.leafIndex < 0) continue;
      this.state.commitments[write.leafIndex] = write.commitment;
      const normalizedCommitment = normalizeHex(write.commitment);
      this.leafIndexByCommitment.set(normalizedCommitment, write.leafIndex);
      const noteIndexes = this.noteIndexesByCommitment.get(normalizedCommitment);
      if (!noteIndexes) continue;
      for (const noteIndex of noteIndexes) {
        const note = this.state.notes[noteIndex];
        if (!note) continue;
        note.leafIndex = write.leafIndex;
        if (note.depositBlock === undefined) {
          note.depositBlock = write.blockNumber;
        }
      }
    }
  }

  private rebuildCommitmentIndexes(): void {
    this.noteIndexesByCommitment.clear();
    for (let i = 0; i < this.state.notes.length; i += 1) {
      const note = this.state.notes[i];
      if (!note) continue;
      const normalizedCommitment = normalizeHex(note.commitment);
      const indexes = this.noteIndexesByCommitment.get(normalizedCommitment) ?? [];
      indexes.push(i);
      this.noteIndexesByCommitment.set(normalizedCommitment, indexes);
    }

    this.leafIndexByCommitment.clear();
    for (let i = 0; i < this.state.commitments.length; i += 1) {
      const commitment = this.state.commitments[i];
      if (!commitment) continue;
      this.leafIndexByCommitment.set(normalizeHex(commitment), i);
    }
  }

  private mapRpcEventsToWrites(params: {
    depositLogs: Array<{
      blockNumber?: bigint;
      logIndex?: number;
      args: { commitment?: Hex; leafIndex?: bigint };
    }>;
    spendLogs: Array<{
      blockNumber?: bigint;
      logIndex?: number;
      args: {
        merchantCommitment?: Hex;
        changeCommitment?: Hex;
        merchantLeafIndex?: bigint;
        changeLeafIndex?: bigint;
      };
    }>;
  }): { writes: CommitmentWrite[]; depositsApplied: number; spendsApplied: number } {
    const writes: CommitmentWrite[] = [];
    let depositsApplied = 0;
    let spendsApplied = 0;

    for (const log of params.depositLogs) {
      const args = log.args;
      if (args.commitment === undefined || args.leafIndex === undefined) continue;
      writes.push({
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        order: 0,
        leafIndex: Number(args.leafIndex),
        commitment: args.commitment
      });
      depositsApplied += 1;
    }

    for (const log of params.spendLogs) {
      const args = log.args;
      if (
        args.merchantCommitment === undefined ||
        args.changeCommitment === undefined ||
        args.merchantLeafIndex === undefined ||
        args.changeLeafIndex === undefined
      ) {
        continue;
      }
      writes.push({
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        order: 0,
        leafIndex: Number(args.merchantLeafIndex),
        commitment: args.merchantCommitment
      });
      writes.push({
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        order: 1,
        leafIndex: Number(args.changeLeafIndex),
        commitment: args.changeCommitment
      });
      spendsApplied += 1;
    }

    return { writes, depositsApplied, spendsApplied };
  }

  private mapIndexerEventsToWrites(
    deposits: IndexerDepositRow[],
    spends: IndexerSpendRow[]
  ): { writes: CommitmentWrite[]; depositsApplied: number; spendsApplied: number } {
    const writes: CommitmentWrite[] = [];
    let depositsApplied = 0;
    let spendsApplied = 0;

    for (const deposit of deposits) {
      const { blockNumber, logIndex } = parseEventPositionFromId(deposit.id);
      writes.push({
        blockNumber,
        logIndex,
        order: 0,
        leafIndex: Number(deposit.leafIndex),
        commitment: deposit.commitment
      });
      depositsApplied += 1;
    }

    for (const spend of spends) {
      const { blockNumber, logIndex } = parseEventPositionFromId(spend.id);
      writes.push({
        blockNumber,
        logIndex,
        order: 0,
        leafIndex: Number(spend.merchantLeafIndex),
        commitment: spend.merchantCommitment
      });
      writes.push({
        blockNumber,
        logIndex,
        order: 1,
        leafIndex: Number(spend.changeLeafIndex),
        commitment: spend.changeCommitment
      });
      spendsApplied += 1;
    }

    return { writes, depositsApplied, spendsApplied };
  }

  async sync(): Promise<WalletSyncResult> {
    if (this.indexerGraphqlUrl) {
      return this.syncFromIndexer();
    }

    if (!this.rpcUrl) {
      throw new Error('wallet state sync requires either rpcUrl or indexerGraphqlUrl');
    }

    const client = createPublicClient({
      transport: http(this.rpcUrl)
    });

    const latest = await client.getBlockNumber();
    const target = latest > this.confirmations ? latest - this.confirmations : 0n;
    const fromCandidate = this.state.lastSyncedBlock + 1n;
    const fromBlock = fromCandidate < this.startBlock ? this.startBlock : fromCandidate;

    if (fromBlock > target) {
      return {
        fromBlock,
        toBlock: target,
        depositsApplied: 0,
        spendsApplied: 0
      };
    }

    let cursor = fromBlock;
    let depositsApplied = 0;
    let spendsApplied = 0;

    while (cursor <= target) {
      const toBlock = cursor + this.chunkSize - 1n > target ? target : cursor + this.chunkSize - 1n;

      const [depositLogs, spendLogs] = await Promise.all([
        client.getLogs({
          address: this.shieldedPoolAddress,
          event: depositedEvent,
          fromBlock: cursor,
          toBlock
        }),
        client.getLogs({
          address: this.shieldedPoolAddress,
          event: spentEvent,
          fromBlock: cursor,
          toBlock
        })
      ]);

      const mapped = this.mapRpcEventsToWrites({
        depositLogs: depositLogs as Array<{
          blockNumber?: bigint;
          logIndex?: number;
          args: { commitment?: Hex; leafIndex?: bigint };
        }>,
        spendLogs: spendLogs as Array<{
          blockNumber?: bigint;
          logIndex?: number;
          args: {
            merchantCommitment?: Hex;
            changeCommitment?: Hex;
            merchantLeafIndex?: bigint;
            changeLeafIndex?: bigint;
          };
        }>
      });

      this.applyCommitmentWrites(mapped.writes);
      depositsApplied += mapped.depositsApplied;
      spendsApplied += mapped.spendsApplied;

      this.state.lastSyncedBlock = toBlock;
      await this.persist();
      cursor = toBlock + 1n;
    }

    return {
      fromBlock,
      toBlock: this.state.lastSyncedBlock,
      depositsApplied,
      spendsApplied
    };
  }

  private async syncFromIndexer(): Promise<WalletSyncResult> {
    const fromBlock = this.state.lastSyncedBlock + 1n;
    const { deposits, spends, maxBlockNumber } = await this.fetchIndexerEvents();
    const mapped = this.mapIndexerEventsToWrites(deposits, spends);
    this.applyCommitmentWrites(mapped.writes);

    const targetBlock = maxBlockNumber >= this.state.lastSyncedBlock ? maxBlockNumber : this.state.lastSyncedBlock;
    this.state.lastSyncedBlock = targetBlock;
    await this.persist();

    return {
      fromBlock,
      toBlock: targetBlock,
      depositsApplied: mapped.depositsApplied,
      spendsApplied: mapped.spendsApplied
    };
  }

  private async fetchIndexerEvents(): Promise<{
    deposits: IndexerDepositRow[];
    spends: IndexerSpendRow[];
    maxBlockNumber: bigint;
  }> {
    const { deposits, spends } = await this.fetchIndexerRows();
    return {
      deposits,
      spends,
      maxBlockNumber: this.computeIndexerMaxBlock(deposits, spends)
    };
  }

  private async indexerPost<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.indexerGraphqlUrl) {
      throw new Error('indexerGraphqlUrl is not configured');
    }
    const payload = await postJson<{ data?: T; errors?: Array<{ message?: string }> }>(
      fetch,
      this.indexerGraphqlUrl,
      {
        query,
        ...(variables ? { variables } : {})
      },
      { errorPrefix: 'indexer graphql request failed' }
    );
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((error) => error.message ?? 'unknown error').join('; ');
      throw new Error(`indexer graphql error: ${message}`);
    }
    if (!payload.data) {
      throw new Error('indexer graphql response missing data');
    }
    return payload.data;
  }

  private async ensureIndexerFieldNames(): Promise<{ deposits: string; spends: string }> {
    if (this.indexerFieldNames) {
      return this.indexerFieldNames;
    }

    const introspection = await this.indexerPost<{
      __schema: { queryType: { fields: Array<{ name: string }> } };
    }>(`query WalletIndexerFields { __schema { queryType { fields { name } } } }`);

    const fieldNames = introspection.__schema.queryType.fields.map((field) => field.name);
    const pickField = (needle: string): string | undefined =>
      fieldNames.find(
        (name) =>
          name.toLowerCase().includes(needle) &&
          !name.toLowerCase().includes('aggregate') &&
          !name.toLowerCase().includes('by_pk')
      );

    const deposits = pickField('shieldedpool_deposited');
    const spends = pickField('shieldedpool_spent');

    if (!deposits || !spends) {
      throw new Error(
        `unable to detect Envio fields for deposits/spends at ${this.indexerGraphqlUrl}; available fields: ${fieldNames.join(', ')}`
      );
    }

    this.indexerFieldNames = { deposits, spends };
    return this.indexerFieldNames;
  }

  private async fetchIndexerRows(): Promise<IndexerEventsRows> {
    const { deposits: depositsField, spends: spendsField } = await this.ensureIndexerFieldNames();

    const withPaginationQuery = `
      query WalletIndexerData($limit: Int!, $offset: Int!) {
        deposits: ${depositsField}(limit: $limit, offset: $offset) {
          id
          commitment
          leafIndex
        }
        spends: ${spendsField}(limit: $limit, offset: $offset) {
          id
          merchantCommitment
          changeCommitment
          merchantLeafIndex
          changeLeafIndex
        }
      }
    `;

    const fullQuery = `
      query WalletIndexerDataAll {
        deposits: ${depositsField} {
          id
          commitment
          leafIndex
        }
        spends: ${spendsField} {
          id
          merchantCommitment
          changeCommitment
          merchantLeafIndex
          changeLeafIndex
        }
      }
    `;

    let deposits: IndexerDepositRow[] = [];
    let spends: IndexerSpendRow[] = [];

    try {
      let offset = 0;
      while (true) {
        const page = await this.indexerPost<IndexerEventsRows>(withPaginationQuery, {
          limit: INDEXER_PAGE_SIZE,
          offset
        });
        deposits = deposits.concat(page.deposits);
        spends = spends.concat(page.spends);
        if (page.deposits.length < INDEXER_PAGE_SIZE && page.spends.length < INDEXER_PAGE_SIZE) {
          break;
        }
        offset += INDEXER_PAGE_SIZE;
      }
    } catch {
      const data = await this.indexerPost<IndexerEventsRows>(fullQuery);
      deposits = data.deposits;
      spends = data.spends;
    }

    return { deposits, spends };
  }

  private computeIndexerMaxBlock(deposits: IndexerDepositRow[], spends: IndexerSpendRow[]): bigint {
    let maxBlockNumber = this.state.lastSyncedBlock;
    for (const deposit of deposits) {
      const position = parseEventPositionFromId(deposit.id);
      if (position.blockNumber > maxBlockNumber) {
        maxBlockNumber = position.blockNumber;
      }
    }
    for (const spend of spends) {
      const position = parseEventPositionFromId(spend.id);
      if (position.blockNumber > maxBlockNumber) {
        maxBlockNumber = position.blockNumber;
      }
    }
    return maxBlockNumber;
  }

  getSpendContextByCommitment(commitment: Hex): ShieldedSpendContext {
    const noteIndex = this.findNoteIndexByCommitment(commitment);
    const note = noteIndex >= 0 ? this.state.notes[noteIndex] : undefined;
    if (!note) {
      throw new Error(
        `note not found in wallet state for commitment ${commitment}; add note secrets first with addOrUpdateNote()`
      );
    }
    if (note.spent) {
      throw new Error(`note ${commitment} is marked spent in wallet state`);
    }

    const leafIndex = note.leafIndex >= 0 ? note.leafIndex : this.findLeafIndex(commitment);
    if (leafIndex < 0) {
      throw new Error(
        `leaf index unknown for note ${commitment}; run sync() or set NOTE_LEAF_INDEX before proving`
      );
    }

    const commitments = [...this.state.commitments];
    for (let i = 0; i < commitments.length; i += 1) {
      if (!commitments[i]) commitments[i] = ZERO_BYTES32;
    }
    const witness = deriveWitness(commitments, leafIndex);

    return {
      note: { ...note, leafIndex },
      witness,
      nullifierSecret: note.nullifierSecret
    };
  }

  private findNoteIndexByCommitment(commitment: Hex): number {
    const normalized = normalizeHex(commitment);
    const noteIndexes = this.noteIndexesByCommitment.get(normalized);
    if (!noteIndexes || noteIndexes.length === 0) return -1;
    return noteIndexes[0] ?? -1;
  }

  private findLeafIndex(commitment: Hex): number {
    const normalized = normalizeHex(commitment);
    return this.leafIndexByCommitment.get(normalized) ?? -1;
  }
}

function parseEventPositionFromId(id: string): { blockNumber: bigint; logIndex: number } {
  const segments = id.split('_');
  if (segments.length < 3) {
    return { blockNumber: 0n, logIndex: 0 };
  }
  const maybeBlock = segments[segments.length - 2] ?? '0';
  const maybeLogIndex = segments[segments.length - 1] ?? '0';
  try {
    return { blockNumber: BigInt(maybeBlock), logIndex: Number(maybeLogIndex) };
  } catch {
    return { blockNumber: 0n, logIndex: 0 };
  }
}
