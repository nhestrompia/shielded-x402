import {
  canonicalAuthorizationBytes,
  canonicalExecutionReportBytes,
  normalizeHex,
  type AuthorizationV1,
  type ExecutionReportV1,
  type Hex
} from '@shielded-x402/shared-types';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function parseHexBytes(value: string, label: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (!/^0x[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${label} must be valid hex`);
  }
  return Uint8Array.from(Buffer.from(normalized.slice(2), 'hex'));
}

export function createEd25519PrivateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error('RELAYER_REPORTING_PRIVATE_KEY must decode to a 32-byte seed');
  }
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function parsePrivateSeed(raw: string | undefined): Uint8Array {
  if (!raw) {
    throw new Error('RELAYER_REPORTING_PRIVATE_KEY is required');
  }
  const bytes = parseHexBytes(raw, 'RELAYER_REPORTING_PRIVATE_KEY');
  if (bytes.length === 32) return bytes;
  if (bytes.length === 64) return bytes.slice(0, 32);
  throw new Error('RELAYER_REPORTING_PRIVATE_KEY must be 32-byte seed or 64-byte key');
}

export function parseSequencerKeyMap(raw: string | undefined): Record<string, Hex> {
  if (!raw) throw new Error('RELAYER_SEQUENCER_KEYS_JSON is required');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RELAYER_SEQUENCER_KEYS_JSON must be an object');
  }
  const out: Record<string, Hex> = {};
  for (const [keyId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    out[keyId] = normalizeHex(value);
  }
  if (Object.keys(out).length === 0) {
    throw new Error('RELAYER_SEQUENCER_KEYS_JSON has no usable keys');
  }
  return out;
}

export function verifySequencerSignature(input: {
  authorization: AuthorizationV1;
  sequencerSig: Hex;
  keyMap: Record<string, Hex>;
}): void {
  const publicKeyHex = input.keyMap[input.authorization.sequencerKeyId];
  if (!publicKeyHex) {
    throw new Error(`unknown sequencer_key_id: ${input.authorization.sequencerKeyId}`);
  }
  const publicKey = parseHexBytes(publicKeyHex, 'sequencer public key');
  if (publicKey.length !== 32) {
    throw new Error('sequencer public key must be 32 bytes');
  }
  const signature = parseHexBytes(input.sequencerSig, 'sequencer signature');
  if (signature.length !== 64) {
    throw new Error('sequencer signature must be 64 bytes');
  }
  const messageHash = sha256(canonicalAuthorizationBytes(input.authorization));
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]);
  const publicKeyObject = createPublicKey({
    key: spki,
    format: 'der',
    type: 'spki'
  });
  const ok = verify(null, messageHash, publicKeyObject, Buffer.from(signature));
  if (!ok) {
    throw new Error('invalid sequencer signature');
  }
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function createExecutionReport(input: {
  authId: Hex;
  chainRef: string;
  executionTxHash: string;
  status: 'SUCCESS' | 'FAILED';
  relayerKeyId: string;
  privateKey: KeyObject;
}): ExecutionReportV1 {
  const report = {
    authId: normalizeHex(input.authId),
    chainRef: input.chainRef,
    executionTxHash: input.executionTxHash.trim(),
    status: input.status,
    reportId: (`0x${randomBytes(32).toString('hex')}` as Hex),
    reportedAt: nowSeconds().toString(),
    relayerKeyId: input.relayerKeyId
  };
  const messageHash = sha256(canonicalExecutionReportBytes(report));
  const signature = sign(null, messageHash, input.privateKey);
  return {
    ...report,
    reportSig: (`0x${Buffer.from(signature).toString('hex')}` as Hex)
  };
}
