import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hex, RelayerSettlementDelta, ShieldedNote } from '@shielded-x402/shared-types';
import { createPublicClient, http, parseAbiItem } from 'viem';
import type { MerkleWitness } from './merkle.js';
import { deriveWitness } from './merkle.js';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

const depositedEvent = parseAbiItem(
  'event Deposited(bytes32 indexed commitment, uint256 indexed leafIndex, bytes32 indexed root, uint256 amount)'
);

const spentEvent = parseAbiItem(
  'event Spent(bytes32 indexed nullifier, bytes32 indexed merchantCommitment, bytes32 indexed changeCommitment, uint256 amount, bytes32 challengeHash, uint256 merchantLeafIndex, uint256 changeLeafIndex, bytes32 newRoot)'
);

interface PersistedNote {
  amount: string;
  rho: Hex;
  pkHash: Hex;
  commitment: Hex;
  leafIndex: number;
  depositBlock?: string;
}

interface PersistedWalletState {
  version: 1;
  poolAddress: Hex;
  lastSyncedBlock: string;
  commitments: Hex[];
  notes: PersistedNote[];
}

export interface WalletNoteRecord extends ShieldedNote {
  depositBlock?: bigint;
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
  payerPkHash: Hex;
}

export interface WalletSyncResult {
  fromBlock: bigint;
  toBlock: bigint;
  depositsApplied: number;
  spendsApplied: number;
}

export interface FileBackedWalletStateConfig {
  filePath: string;
  rpcUrl: string;
  shieldedPoolAddress: Hex;
  startBlock?: bigint;
  confirmations?: bigint;
  chunkSize?: bigint;
}

interface InMemoryWalletState {
  lastSyncedBlock: bigint;
  commitments: Hex[];
  notes: WalletNoteRecord[];
}

interface CommitmentWrite {
  blockNumber: bigint;
  logIndex: number;
  order: number;
  leafIndex: number;
  commitment: Hex;
}

function normalizeHex(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

function serialize(state: InMemoryWalletState, poolAddress: Hex): PersistedWalletState {
  return {
    version: 1,
    poolAddress,
    lastSyncedBlock: state.lastSyncedBlock.toString(),
    commitments: state.commitments,
    notes: state.notes.map((note) => ({
      amount: note.amount.toString(),
      rho: note.rho,
      pkHash: note.pkHash,
      commitment: note.commitment,
      leafIndex: note.leafIndex,
      ...(note.depositBlock !== undefined ? { depositBlock: note.depositBlock.toString() } : {})
    }))
  };
}

function deserialize(payload: PersistedWalletState): InMemoryWalletState {
  return {
    lastSyncedBlock: BigInt(payload.lastSyncedBlock),
    commitments: payload.commitments,
    notes: payload.notes.map((note) => ({
      amount: BigInt(note.amount),
      rho: note.rho,
      pkHash: note.pkHash,
      commitment: note.commitment,
      leafIndex: note.leafIndex,
      ...(note.depositBlock !== undefined ? { depositBlock: BigInt(note.depositBlock) } : {})
    }))
  };
}

export class FileBackedWalletState {
  private readonly filePath: string;
  private readonly rpcUrl: string;
  private readonly shieldedPoolAddress: Hex;
  private readonly confirmations: bigint;
  private readonly chunkSize: bigint;
  private readonly startBlock: bigint;
  private state: InMemoryWalletState;

  private constructor(config: FileBackedWalletStateConfig) {
    this.filePath = config.filePath;
    this.rpcUrl = config.rpcUrl;
    this.shieldedPoolAddress = config.shieldedPoolAddress;
    this.confirmations = config.confirmations ?? 2n;
    this.chunkSize = config.chunkSize ?? 2_000n;
    this.startBlock = config.startBlock ?? 0n;
    this.state = {
      lastSyncedBlock: this.startBlock - 1n,
      commitments: [],
      notes: []
    };
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
      if (parsed.version !== 1) {
        throw new Error(`unsupported wallet state version: ${String(parsed.version)}`);
      }
      if (normalizeHex(parsed.poolAddress) !== normalizeHex(this.shieldedPoolAddress)) {
        throw new Error(
          `wallet state pool mismatch: expected ${this.shieldedPoolAddress}, found ${parsed.poolAddress}`
        );
      }
      this.state = deserialize(parsed);
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

  async addOrUpdateNote(note: ShieldedNote, depositBlock?: bigint): Promise<void> {
    const normalizedCommitment = normalizeHex(note.commitment);
    const existingIndex = this.state.notes.findIndex(
      (candidate) => normalizeHex(candidate.commitment) === normalizedCommitment
    );
    const record: WalletNoteRecord = {
      ...note,
      ...(depositBlock !== undefined ? { depositBlock } : {})
    };

    if (existingIndex >= 0) {
      this.state.notes[existingIndex] = record;
    } else {
      this.state.notes.push(record);
    }

    if (record.leafIndex >= 0) {
      this.state.commitments[record.leafIndex] = record.commitment;
    }
    await this.persist();
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
    } else {
      this.state.commitments.push(params.merchantCommitment, params.changeCommitment);
    }
    await this.persist();
  }

  async applyRelayerSettlement(params: {
    settlementDelta?: RelayerSettlementDelta;
    changeNote?: ShieldedNote;
  }): Promise<void> {
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
      await this.addOrUpdateNote(
        {
          ...params.changeNote,
          leafIndex: changeLeafIndex
        },
        this.state.lastSyncedBlock >= 0n ? this.state.lastSyncedBlock : undefined
      );
    }
  }

  async sync(): Promise<WalletSyncResult> {
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

      const writes: CommitmentWrite[] = [];
      for (const log of depositLogs) {
        const args = log.args as { commitment?: Hex; leafIndex?: bigint };
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

      for (const log of spendLogs) {
        const args = log.args as {
          merchantCommitment?: Hex;
          changeCommitment?: Hex;
          merchantLeafIndex?: bigint;
          changeLeafIndex?: bigint;
        };
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

      writes.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
        return a.order - b.order;
      });

      for (const write of writes) {
        if (write.leafIndex < 0) continue;
        this.state.commitments[write.leafIndex] = write.commitment;
        const normalized = normalizeHex(write.commitment);
        for (let i = 0; i < this.state.notes.length; i += 1) {
          const note = this.state.notes[i];
          if (!note) continue;
          if (normalizeHex(note.commitment) !== normalized) continue;
          note.leafIndex = write.leafIndex;
          if (note.depositBlock === undefined) {
            note.depositBlock = write.blockNumber;
          }
        }
      }

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

  getSpendContextByCommitment(commitment: Hex, payerPkHash: Hex): ShieldedSpendContext {
    const normalized = normalizeHex(commitment);
    const note = this.state.notes.find((candidate) => normalizeHex(candidate.commitment) === normalized);
    if (!note) {
      throw new Error(
        `note not found in wallet state for commitment ${commitment}; add note secrets first with addOrUpdateNote()`
      );
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
      payerPkHash
    };
  }

  private findLeafIndex(commitment: Hex): number {
    const normalized = normalizeHex(commitment);
    for (let i = this.state.commitments.length - 1; i >= 0; i -= 1) {
      const candidate = this.state.commitments[i];
      if (!candidate) continue;
      if (normalizeHex(candidate) === normalized) return i;
    }
    return -1;
  }
}
