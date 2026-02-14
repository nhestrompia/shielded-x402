import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptNote,
  decryptNoteWithPrivateKey,
  encryptNote,
  encryptNoteForPublicKey,
  generateNoteEncryptionKeyPair
} from './notes.js';

describe('note encryption', () => {
  const note = {
    amount: 1_000_000n,
    rho: '0x1111111111111111111111111111111111111111111111111111111111111111',
    pkHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    commitment: '0x3333333333333333333333333333333333333333333333333333333333333333',
    leafIndex: 7
  } as const;

  it('roundtrips symmetric encryption', () => {
    const key = randomBytes(32);
    const encrypted = encryptNote(note, key);
    const decrypted = decryptNote(encrypted, key);

    expect(decrypted.amount).toBe(note.amount);
    expect(decrypted.commitment).toBe(note.commitment);
  });

  it('roundtrips ECDH envelope encryption', () => {
    const keyPair = generateNoteEncryptionKeyPair();
    const encrypted = encryptNoteForPublicKey(note, keyPair.publicKey);
    const decrypted = decryptNoteWithPrivateKey(encrypted, keyPair.privateKey);

    expect(decrypted.amount).toBe(note.amount);
    expect(decrypted.pkHash).toBe(note.pkHash);
  });
});
