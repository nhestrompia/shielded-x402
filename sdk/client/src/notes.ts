import type { Hex, ShieldedNote } from '@shielded-x402/shared-types';
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes
} from 'node:crypto';

const NOTE_ENC_VERSION = 1;
const INFO_LABEL = Buffer.from('shielded-x402:note-ecdh:v1', 'utf8');

export interface StoredNote {
  note: ShieldedNote;
  ciphertext?: Hex;
}

export interface NoteEncryptionKeyPair {
  privateKey: Hex;
  publicKey: Hex;
}

export function generateNoteEncryptionKeyPair(): NoteEncryptionKeyPair {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  return {
    privateKey: (`0x${ecdh.getPrivateKey().toString('hex')}`) as Hex,
    publicKey: (`0x${ecdh.getPublicKey(undefined, 'uncompressed').toString('hex')}`) as Hex
  };
}

export function serializeNote(note: ShieldedNote): string {
  return JSON.stringify({
    amount: note.amount.toString(),
    rho: note.rho,
    pkHash: note.pkHash,
    commitment: note.commitment,
    leafIndex: note.leafIndex
  });
}

export function deserializeNote(value: string): ShieldedNote {
  const parsed = JSON.parse(value) as {
    amount: string;
    rho: Hex;
    pkHash: Hex;
    commitment: Hex;
    leafIndex: number;
  };

  return {
    amount: BigInt(parsed.amount),
    rho: parsed.rho,
    pkHash: parsed.pkHash,
    commitment: parsed.commitment,
    leafIndex: parsed.leafIndex
  };
}

export function encryptNoteSymmetric(note: ShieldedNote, key: Buffer): Hex {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(serializeNote(note), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (`0x${Buffer.concat([iv, tag, encrypted]).toString('hex')}`) as Hex;
}

export function decryptNoteSymmetric(ciphertext: Hex, key: Buffer): ShieldedNote {
  const bytes = Buffer.from(ciphertext.slice(2), 'hex');
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const encrypted = bytes.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return deserializeNote(plaintext.toString('utf8'));
}

function deriveAesKey(sharedSecret: Buffer): Buffer {
  const key = hkdfSync('sha256', sharedSecret, Buffer.alloc(0), INFO_LABEL, 32);
  return Buffer.from(key);
}

export function encryptNoteForPublicKey(
  note: ShieldedNote,
  recipientPublicKey: Hex,
  aad?: Uint8Array
): Hex {
  const recipientPub = Buffer.from(recipientPublicKey.slice(2), 'hex');
  const eph = createECDH('secp256k1');
  eph.generateKeys();

  const sharedSecret = eph.computeSecret(recipientPub);
  const aesKey = deriveAesKey(sharedSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);

  if (aad) {
    cipher.setAAD(Buffer.from(aad));
  }

  const payload = Buffer.from(serializeNote(note), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ephPub = eph.getPublicKey(undefined, 'uncompressed');

  const envelope = Buffer.concat([
    Buffer.from([NOTE_ENC_VERSION]),
    ephPub,
    iv,
    tag,
    encrypted
  ]);

  return (`0x${envelope.toString('hex')}`) as Hex;
}

export function decryptNoteWithPrivateKey(
  envelopeCiphertext: Hex,
  recipientPrivateKey: Hex,
  aad?: Uint8Array
): ShieldedNote {
  const bytes = Buffer.from(envelopeCiphertext.slice(2), 'hex');
  if (bytes.length < 1 + 65 + 12 + 16) {
    throw new Error('invalid envelope length');
  }

  const version = bytes[0];
  if (version !== NOTE_ENC_VERSION) {
    throw new Error(`unsupported note envelope version: ${version}`);
  }

  const ephPub = bytes.subarray(1, 66);
  const iv = bytes.subarray(66, 78);
  const tag = bytes.subarray(78, 94);
  const encrypted = bytes.subarray(94);

  const recipient = createECDH('secp256k1');
  recipient.setPrivateKey(Buffer.from(recipientPrivateKey.slice(2), 'hex'));
  const sharedSecret = recipient.computeSecret(ephPub);
  const aesKey = deriveAesKey(sharedSecret);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  if (aad) {
    decipher.setAAD(Buffer.from(aad));
  }
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return deserializeNote(plaintext.toString('utf8'));
}

// Backward-compatible aliases.
export const encryptNote = encryptNoteSymmetric;
export const decryptNote = decryptNoteSymmetric;
