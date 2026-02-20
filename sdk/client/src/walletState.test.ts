import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Hex } from '@shielded-x402/shared-types';
import { FileBackedWalletState } from './walletState.js';

const toWord = (value: bigint): Hex =>
  (`0x${value.toString(16).padStart(64, '0')}` as Hex);

describe('FileBackedWalletState', () => {
  it('persists and reloads note-specific nullifier secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wallet-state-test-'));
    try {
      const filePath = join(dir, 'wallet-state.json');
      const pool = '0x0000000000000000000000000000000000000001' as Hex;
      const note = {
        amount: 100n,
        rho: toWord(42n),
        pkHash: toWord(11n),
        commitment: toWord(1111n),
        leafIndex: 0
      };
      const nullifierSecret = toWord(999n);

      const state = await FileBackedWalletState.create({
        filePath,
        shieldedPoolAddress: pool,
        startBlock: 0n
      });
      await state.addOrUpdateNote(note, nullifierSecret);

      const context = state.getSpendContextByCommitment(note.commitment);
      expect(context.nullifierSecret).toBe(nullifierSecret);

      const reloaded = await FileBackedWalletState.create({
        filePath,
        shieldedPoolAddress: pool,
        startBlock: 0n
      });
      const [stored] = reloaded.getNotes();
      expect(stored?.nullifierSecret).toBe(nullifierSecret);
      expect(reloaded.getSpendContextByCommitment(note.commitment).nullifierSecret).toBe(
        nullifierSecret
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records change note with its own nullifier secret on settlement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wallet-state-test-'));
    try {
      const filePath = join(dir, 'wallet-state.json');
      const pool = '0x0000000000000000000000000000000000000002' as Hex;
      const inputNote = {
        amount: 100n,
        rho: toWord(42n),
        pkHash: toWord(11n),
        commitment: toWord(2222n),
        leafIndex: 0
      };
      const inputSecret = toWord(777n);
      const changeNote = {
        amount: 60n,
        rho: toWord(43n),
        pkHash: toWord(11n),
        commitment: toWord(3333n),
        leafIndex: -1
      };
      const changeSecret = toWord(888n);

      const state = await FileBackedWalletState.create({
        filePath,
        shieldedPoolAddress: pool,
        startBlock: 0n
      });
      await state.addOrUpdateNote(inputNote, inputSecret);

      await state.applyRelayerSettlement({
        settlementDelta: {
          merchantCommitment: toWord(4444n),
          changeCommitment: changeNote.commitment,
          merchantLeafIndex: 1,
          changeLeafIndex: 2,
          newRoot: toWord(5555n)
        },
        changeNote,
        changeNullifierSecret: changeSecret,
        spentNoteCommitment: inputNote.commitment
      });

      const notes = state.getNotes();
      const spent = notes.find((note) => note.commitment === inputNote.commitment);
      const change = notes.find((note) => note.commitment === changeNote.commitment);

      expect(spent?.spent).toBe(true);
      expect(change?.nullifierSecret).toBe(changeSecret);
      expect(change?.leafIndex).toBe(2);
      expect(state.getSpendContextByCommitment(changeNote.commitment).nullifierSecret).toBe(
        changeSecret
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists, reloads, and clears credit channel state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wallet-state-test-'));
    try {
      const filePath = join(dir, 'wallet-state.json');
      const pool = '0x0000000000000000000000000000000000000003' as Hex;
      const channelId =
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
      const signedState = {
        state: {
          channelId,
          seq: '3',
          available: '70',
          cumulativeSpent: '30',
          lastDebitDigest:
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
          updatedAt: '1700000000',
          agentAddress: '0x0000000000000000000000000000000000000001' as Hex,
          relayerAddress: '0x0000000000000000000000000000000000000002' as Hex
        },
        agentSignature:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b' as Hex,
        relayerSignature:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b' as Hex
      };

      const state = await FileBackedWalletState.create({
        filePath,
        shieldedPoolAddress: pool,
        startBlock: 0n
      });
      await state.setCreditState(signedState);

      const reloaded = await FileBackedWalletState.create({
        filePath,
        shieldedPoolAddress: pool,
        startBlock: 0n
      });
      const loaded = reloaded.getCreditState(channelId);
      expect(loaded?.state.seq).toBe('3');
      expect(loaded?.state.available).toBe('70');

      await reloaded.clearCreditState(channelId);
      const cleared = reloaded.getCreditState(channelId);
      expect(cleared).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
