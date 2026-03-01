import { canonicalAuthorizationBytes, type AuthorizationV1, type Hex } from '@shielded-x402/shared-types';
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { parseHexBytes } from './lib.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function createEd25519PrivateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error('ed25519 seed must be 32 bytes');
  }
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function createEd25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new Error('ed25519 public key must be 32 bytes');
  }
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

export function extractEd25519RawPublicKey(publicKey: KeyObject): Hex {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const derBytes = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const raw = derBytes.subarray(derBytes.length - 32);
  return (`0x${raw.toString('hex')}` as Hex);
}

export function signAuthorization(privateKey: KeyObject, authorization: AuthorizationV1): Hex {
  const msgHash = authorizationMessageHash(authorization);
  const sig = sign(null, msgHash, privateKey);
  return (`0x${Buffer.from(sig).toString('hex')}` as Hex);
}

export function authorizationMessageHash(authorization: AuthorizationV1): Buffer {
  return sha256(canonicalAuthorizationBytes(authorization));
}

export function verifyEd25519Signature(input: {
  messageHash: Buffer;
  signature: Hex;
  publicKey: Hex;
}): boolean {
  const sigBytes = parseHexBytes(input.signature, 'signature');
  const pubBytes = parseHexBytes(input.publicKey, 'publicKey');
  if (sigBytes.length !== 64) {
    throw new Error('invalid ed25519 signature length');
  }
  if (pubBytes.length !== 32) {
    throw new Error('invalid ed25519 public key length');
  }
  const publicKey = createEd25519PublicKeyFromRaw(pubBytes);
  return verify(null, input.messageHash, publicKey, sigBytes);
}

async function dynamicImport(moduleName: string): Promise<any> {
  return import(moduleName);
}

let recoverTypedDataAddressFn: ((args: unknown) => Promise<string>) | null = null;

export async function recoverTypedDataAddressRuntime(args: unknown): Promise<string> {
  if (!recoverTypedDataAddressFn) {
    const mod = await dynamicImport('viem');
    recoverTypedDataAddressFn = mod.recoverTypedDataAddress as (args: unknown) => Promise<string>;
  }
  return recoverTypedDataAddressFn(args);
}
