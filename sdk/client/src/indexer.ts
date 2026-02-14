import type { Hex, ShieldedNote } from '@shielded-x402/shared-types';

export interface DepositEvent {
  commitment: Hex;
  leafIndex: number;
  amount: bigint;
}

export interface SpendEvent {
  merchantCommitment: Hex;
  changeCommitment: Hex;
}

export interface NoteState {
  commitments: Hex[];
  notes: ShieldedNote[];
}

export class LocalNoteIndexer {
  private readonly state: NoteState = {
    commitments: [],
    notes: []
  };

  ingestDeposit(event: DepositEvent, note: ShieldedNote): void {
    this.state.commitments[event.leafIndex] = event.commitment;
    this.state.notes.push(note);
  }

  ingestSpend(event: SpendEvent): void {
    this.state.commitments.push(event.merchantCommitment, event.changeCommitment);
  }

  getCommitments(): Hex[] {
    return [...this.state.commitments];
  }

  getNotes(): ShieldedNote[] {
    return [...this.state.notes];
  }
}
