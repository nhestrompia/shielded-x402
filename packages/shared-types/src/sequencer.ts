import { createHash } from 'node:crypto';
import type { Hex } from './types.js';
import { isHex32, normalizeHex } from './hex.js';

export const X402_DOMAIN_TAGS = {
  intentV1: 'x402:intent:v1',
  authorizationV1: 'x402:authorization:v1',
  authLeafV1: 'x402:authleaf:v1',
  executionReportV1: 'x402:execution-report:v1'
} as const;

export const OPTIONAL_INTENT_BITMAP = {
  serviceHash: 1 << 0,
  memoHash: 1 << 1
} as const;

export const SEQUENCER_ROUTES_V1 = {
  authorize: '/v1/credit/authorize',
  executions: '/v1/credit/executions',
  reclaim: '/v1/credit/reclaim',
  commitmentsLatest: '/v1/commitments/latest',
  commitmentsProof: '/v1/commitments/proof',
  adminCredit: '/v1/admin/credit'
} as const;

export const RELAYER_ROUTES_V1 = {
  pay: '/v1/relay/pay'
} as const;

export type SignatureScheme = 'eip712-secp256k1' | 'ed25519-sha256-v1';

export type AuthorizationStatus = 'ISSUED' | 'EXECUTED' | 'RECLAIMED';

export interface IntentV1 {
  version: 1;
  agentId: Hex;
  agentPubKey: Hex;
  signatureScheme: SignatureScheme;
  agentNonce: string;
  amountMicros: string;
  merchantId: Hex;
  requiredChainRef: string;
  expiresAt: string;
  requestId: Hex;
  serviceHash?: Hex;
  memoHash?: Hex;
}

export interface AuthorizationV1 {
  version: 1;
  intentId: Hex;
  authId: Hex;
  authorizedAmountMicros: string;
  agentId: Hex;
  agentNonce: string;
  merchantId: Hex;
  chainRef: string;
  issuedAt: string;
  expiresAt: string;
  sequencerEpochHint: string;
  logSeqNo: string;
  sequencerKeyId: string;
}

export interface AuthorizeRequestV1 {
  intent: IntentV1;
  agentSig: Hex;
}

export interface AuthorizeResponseV1 {
  authorization: AuthorizationV1;
  sequencerSig: Hex;
  idempotent: boolean;
}

export interface ExecutionReportV1 {
  authId: Hex;
  chainRef: string;
  executionTxHash: string;
  status: 'SUCCESS' | 'FAILED';
  reportId: Hex;
  reportedAt: string;
  relayerKeyId: string;
  reportSig: Hex;
}

export interface ReclaimRequestV1 {
  authId: Hex;
  callerType: 'agent' | 'sequencer';
  agentId?: Hex;
  requestedAt: string;
  agentSig?: Hex;
}

export type SignedExecutionReportPayloadV1 = Omit<ExecutionReportV1, 'reportSig'>;

export type SignedReclaimPayloadV1 = Omit<ReclaimRequestV1, 'agentSig'>;

export interface CommitmentMetadataV1 {
  epochId: string;
  root: Hex;
  count: number;
  prevRoot: Hex;
  sequencerKeyId: string;
  postedAt?: string;
  postedTxHash?: Hex;
}

export interface InclusionProofV1 {
  epochId: string;
  root: Hex;
  leafHash: Hex;
  merkleProof: Hex[];
  leafIndex: number;
  logSeqNo: string;
  prevRoot: Hex;
  authId: Hex;
  leafSalt: Hex;
  sequencerKeyId: string;
  commitTxHash?: Hex;
}

export interface RelayPayRequestV1 {
  authorization: AuthorizationV1;
  sequencerSig: Hex;
  merchantRequest: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
  };
}

export interface RelayPayResponseV1 {
  executionTxHash: string;
  authId: Hex;
  status: 'DONE' | 'FAILED';
  failureReason?: string;
  merchantResult?: {
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
  };
}

function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

function sha256Hex(input: Buffer | string): Hex {
  return (`0x${sha256(input).toString('hex')}` as Hex);
}

function hashWithTag(tag: string, payload: Buffer): Hex {
  const tagBytes = Buffer.from(tag, 'utf8');
  return sha256Hex(Buffer.concat([tagBytes, Buffer.from([0]), payload]));
}

function encodeU8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`u8 out of range: ${value}`);
  }
  return Buffer.from([value]);
}

function encodeU16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`u16 out of range: ${value}`);
  }
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value, 0);
  return out;
}

function parseUint64String(value: string, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`invalid uint64 for ${label}`);
  }
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`uint64 out of range for ${label}`);
  }
  return parsed;
}

function encodeU64(value: string, label: string): Buffer {
  const parsed = parseUint64String(value, label);
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(parsed, 0);
  return out;
}

function encodeHex32(value: Hex, label: string): Buffer {
  const normalized = normalizeHex(value);
  if (!isHex32(normalized)) {
    throw new Error(`${label} must be 32-byte hex`);
  }
  return Buffer.from(normalized.slice(2), 'hex');
}

function encodeHexBytes(value: Hex, label: string): Buffer {
  const normalized = normalizeHex(value);
  if (!/^0x[0-9a-f]*$/i.test(normalized)) {
    throw new Error(`${label} must be hex`);
  }
  const hex = normalized.slice(2);
  if (hex.length % 2 !== 0) {
    throw new Error(`${label} hex length must be even`);
  }
  return Buffer.from(hex, 'hex');
}

function encodeUtf8WithU16Length(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 0xffff) {
    throw new Error(`${label} exceeds 65535 bytes`);
  }
  return Buffer.concat([encodeU16(bytes.length), bytes]);
}

function buildIntentOptionalBitmap(intent: IntentV1): number {
  let bitmap = 0;
  if (intent.serviceHash) bitmap |= OPTIONAL_INTENT_BITMAP.serviceHash;
  if (intent.memoHash) bitmap |= OPTIONAL_INTENT_BITMAP.memoHash;
  return bitmap;
}

export function canonicalIntentBytes(intent: IntentV1): Buffer {
  if (intent.version !== 1) throw new Error('Intent version must be 1');

  const signatureSchemeCode =
    intent.signatureScheme === 'eip712-secp256k1'
      ? 1
      : intent.signatureScheme === 'ed25519-sha256-v1'
        ? 2
        : 0;
  if (signatureSchemeCode === 0) {
    throw new Error(`unsupported signature scheme: ${intent.signatureScheme}`);
  }

  const bitmap = buildIntentOptionalBitmap(intent);

  const fields = [
    encodeU8(intent.version),
    encodeHex32(intent.agentId, 'agentId'),
    encodeU8(signatureSchemeCode),
    (() => {
      const pubKeyBytes = encodeHexBytes(intent.agentPubKey, 'agentPubKey');
      return Buffer.concat([encodeU16(pubKeyBytes.length), pubKeyBytes]);
    })(),
    encodeU64(intent.agentNonce, 'agentNonce'),
    encodeU64(intent.amountMicros, 'amountMicros'),
    encodeHex32(intent.merchantId, 'merchantId'),
    encodeUtf8WithU16Length(intent.requiredChainRef, 'requiredChainRef'),
    encodeU64(intent.expiresAt, 'expiresAt'),
    encodeHex32(intent.requestId, 'requestId'),
    encodeU8(bitmap)
  ];

  if (bitmap & OPTIONAL_INTENT_BITMAP.serviceHash) {
    fields.push(encodeHex32(intent.serviceHash as Hex, 'serviceHash'));
  }
  if (bitmap & OPTIONAL_INTENT_BITMAP.memoHash) {
    fields.push(encodeHex32(intent.memoHash as Hex, 'memoHash'));
  }

  return Buffer.concat(fields);
}

export function canonicalAuthorizationBytes(authorization: AuthorizationV1): Buffer {
  if (authorization.version !== 1) {
    throw new Error('Authorization version must be 1');
  }
  if (authorization.sequencerKeyId.trim().length === 0) {
    throw new Error('sequencerKeyId is required');
  }

  return Buffer.concat([
    encodeU8(authorization.version),
    encodeHex32(authorization.intentId, 'intentId'),
    encodeHex32(authorization.authId, 'authId'),
    encodeU64(authorization.authorizedAmountMicros, 'authorizedAmountMicros'),
    encodeHex32(authorization.agentId, 'agentId'),
    encodeU64(authorization.agentNonce, 'agentNonce'),
    encodeHex32(authorization.merchantId, 'merchantId'),
    encodeUtf8WithU16Length(authorization.chainRef, 'chainRef'),
    encodeU64(authorization.issuedAt, 'issuedAt'),
    encodeU64(authorization.expiresAt, 'expiresAt'),
    encodeU64(authorization.sequencerEpochHint, 'sequencerEpochHint'),
    encodeU64(authorization.logSeqNo, 'logSeqNo'),
    encodeUtf8WithU16Length(authorization.sequencerKeyId, 'sequencerKeyId')
  ]);
}

export function canonicalExecutionReportBytes(report: SignedExecutionReportPayloadV1): Buffer {
  const statusCode =
    report.status === 'SUCCESS' ? 1 : report.status === 'FAILED' ? 2 : 0;
  if (statusCode === 0) {
    throw new Error(`unsupported execution status: ${String(report.status)}`);
  }
  return Buffer.concat([
    encodeHex32(report.authId, 'authId'),
    encodeUtf8WithU16Length(report.chainRef, 'chainRef'),
    encodeUtf8WithU16Length(report.executionTxHash, 'executionTxHash'),
    encodeU8(statusCode),
    encodeHex32(report.reportId, 'reportId'),
    encodeU64(report.reportedAt, 'reportedAt'),
    encodeUtf8WithU16Length(report.relayerKeyId, 'relayerKeyId')
  ]);
}

export function canonicalReclaimRequestBytes(request: SignedReclaimPayloadV1): Buffer {
  const callerTypeCode =
    request.callerType === 'agent' ? 1 : request.callerType === 'sequencer' ? 2 : 0;
  if (callerTypeCode === 0) {
    throw new Error(`unsupported reclaim callerType: ${String(request.callerType)}`);
  }
  return Buffer.concat([
    encodeHex32(request.authId, 'authId'),
    encodeU8(callerTypeCode),
    (() => {
      if (!request.agentId) {
        return Buffer.concat([encodeU16(0), Buffer.alloc(0)]);
      }
      const idBytes = encodeHex32(request.agentId, 'agentId');
      return Buffer.concat([encodeU16(idBytes.length), idBytes]);
    })(),
    encodeU64(request.requestedAt, 'requestedAt')
  ]);
}

export function hashIntent(intent: IntentV1): Hex {
  return hashWithTag(X402_DOMAIN_TAGS.intentV1, canonicalIntentBytes(intent));
}

export function hashAuthorization(authorization: AuthorizationV1): Hex {
  return hashWithTag(X402_DOMAIN_TAGS.authorizationV1, canonicalAuthorizationBytes(authorization));
}

export function hashExecutionReport(report: SignedExecutionReportPayloadV1): Hex {
  return hashWithTag(X402_DOMAIN_TAGS.executionReportV1, canonicalExecutionReportBytes(report));
}

export function deriveAuthorizationId(input: {
  intentId: Hex;
  sequencerEpoch: string;
  seqNo: string;
}): Hex {
  return hashWithTag(
    X402_DOMAIN_TAGS.authorizationV1,
    Buffer.concat([
      Buffer.from('id', 'utf8'),
      encodeHex32(input.intentId, 'intentId'),
      encodeU64(input.sequencerEpoch, 'sequencerEpoch'),
      encodeU64(input.seqNo, 'seqNo')
    ])
  );
}

export function deriveLeafSalt(secret: Hex, authId: Hex): Hex {
  const secretBytes = encodeHexBytes(secret, 'sequencerSecret');
  return sha256Hex(Buffer.concat([secretBytes, encodeHex32(authId, 'authId')]));
}

export function computeAuthorizationLeaf(input: {
  logSeqNo: string;
  prevLeafHash: Hex;
  authHash: Hex;
  salt: Hex;
}): Hex {
  return hashWithTag(
    X402_DOMAIN_TAGS.authLeafV1,
    Buffer.concat([
      encodeU64(input.logSeqNo, 'logSeqNo'),
      encodeHex32(input.prevLeafHash, 'prevLeafHash'),
      encodeHex32(input.authHash, 'authHash'),
      encodeHex32(input.salt, 'salt')
    ])
  );
}

export function normalizeMerchantEndpointUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol.toLowerCase() !== 'https:') {
    throw new Error('merchant endpoint must use https');
  }
  const protocol = 'https:';
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port === '' || parsed.port === '443' ? '' : `:${parsed.port}`;

  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  return `${protocol}//${hostname}${port}${pathname}`;
}

export function deriveMerchantId(input: {
  serviceRegistryId: string;
  endpointUrl: string;
}): Hex {
  const normalizedUrl = normalizeMerchantEndpointUrl(input.endpointUrl);
  const registryBytes = Buffer.from(input.serviceRegistryId, 'utf8');
  const urlBytes = Buffer.from(normalizedUrl, 'utf8');
  return sha256Hex(Buffer.concat([registryBytes, Buffer.from([0]), urlBytes]));
}

function hashPair(left: Hex, right: Hex): Hex {
  return sha256Hex(Buffer.concat([encodeHex32(left, 'left'), encodeHex32(right, 'right')]));
}

export function buildMerkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) {
    return (`0x${'00'.repeat(32)}` as Hex);
  }

  let level = leaves.map((leaf) => normalizeHex(leaf));
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = (level[i + 1] ?? left) as Hex;
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0] as Hex;
}

export function buildMerkleProof(leaves: readonly Hex[], leafIndex: number): Hex[] {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error('leafIndex out of bounds');
  }
  let index = leafIndex;
  let level = leaves.map((leaf) => normalizeHex(leaf));
  const proof: Hex[] = [];

  while (level.length > 1) {
    const siblingIndex = index ^ 1;
    const sibling = (level[siblingIndex] ?? level[index]) as Hex;
    proof.push(sibling);

    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = (level[i + 1] ?? left) as Hex;
      next.push(hashPair(left, right));
    }

    index = Math.floor(index / 2);
    level = next;
  }

  return proof;
}

export function verifyMerkleProof(input: {
  leafHash: Hex;
  leafIndex: number;
  proof: readonly Hex[];
  expectedRoot: Hex;
}): boolean {
  let computed = normalizeHex(input.leafHash);
  let index = input.leafIndex;

  for (const siblingRaw of input.proof) {
    const sibling = normalizeHex(siblingRaw);
    if (index % 2 === 0) {
      computed = hashPair(computed, sibling);
    } else {
      computed = hashPair(sibling, computed);
    }
    index = Math.floor(index / 2);
  }

  return normalizeHex(computed) === normalizeHex(input.expectedRoot);
}

export function buildIntentTypedDataPayload(intent: IntentV1): {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: {
    IntentV1: Array<{ name: string; type: string }>;
  };
  primaryType: 'IntentV1';
  message: {
    version: number;
    agentId: Hex;
    signatureScheme: number;
    agentPubKey: Hex;
    agentNonce: bigint;
    amountMicros: bigint;
    merchantId: Hex;
    requiredChainRef: string;
    expiresAt: bigint;
    requestId: Hex;
    serviceHash: Hex;
    memoHash: Hex;
  };
} {
  return {
    domain: {
      name: X402_DOMAIN_TAGS.intentV1,
      version: '1',
      chainId: 1,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    },
    types: {
      IntentV1: [
        { name: 'version', type: 'uint8' },
        { name: 'agentId', type: 'bytes32' },
        { name: 'signatureScheme', type: 'uint8' },
        { name: 'agentPubKey', type: 'bytes' },
        { name: 'agentNonce', type: 'uint64' },
        { name: 'amountMicros', type: 'uint64' },
        { name: 'merchantId', type: 'bytes32' },
        { name: 'requiredChainRef', type: 'string' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'requestId', type: 'bytes32' },
        { name: 'serviceHash', type: 'bytes32' },
        { name: 'memoHash', type: 'bytes32' }
      ]
    },
    primaryType: 'IntentV1',
    message: {
      version: intent.version,
      agentId: normalizeHex(intent.agentId),
      signatureScheme: intent.signatureScheme === 'eip712-secp256k1' ? 1 : 2,
      agentPubKey: normalizeHex(intent.agentPubKey),
      agentNonce: parseUint64String(intent.agentNonce, 'agentNonce'),
      amountMicros: parseUint64String(intent.amountMicros, 'amountMicros'),
      merchantId: normalizeHex(intent.merchantId),
      requiredChainRef: intent.requiredChainRef,
      expiresAt: parseUint64String(intent.expiresAt, 'expiresAt'),
      requestId: normalizeHex(intent.requestId),
      serviceHash: intent.serviceHash ? normalizeHex(intent.serviceHash) : (`0x${'00'.repeat(32)}` as Hex),
      memoHash: intent.memoHash ? normalizeHex(intent.memoHash) : (`0x${'00'.repeat(32)}` as Hex)
    }
  };
}

export function buildReclaimTypedDataPayload(request: SignedReclaimPayloadV1): {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  types: {
    ReclaimV1: Array<{ name: string; type: string }>;
  };
  primaryType: 'ReclaimV1';
  message: {
    authId: Hex;
    callerType: number;
    agentId: Hex;
    requestedAt: bigint;
  };
} {
  const callerTypeCode =
    request.callerType === 'agent' ? 1 : request.callerType === 'sequencer' ? 2 : 0;
  if (callerTypeCode === 0) {
    throw new Error(`unsupported reclaim callerType: ${String(request.callerType)}`);
  }
  const zeroHash = (`0x${'00'.repeat(32)}` as Hex);
  return {
    domain: {
      name: X402_DOMAIN_TAGS.authorizationV1,
      version: '1',
      chainId: 1,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    },
    types: {
      ReclaimV1: [
        { name: 'authId', type: 'bytes32' },
        { name: 'callerType', type: 'uint8' },
        { name: 'agentId', type: 'bytes32' },
        { name: 'requestedAt', type: 'uint64' }
      ]
    },
    primaryType: 'ReclaimV1',
    message: {
      authId: normalizeHex(request.authId),
      callerType: callerTypeCode,
      agentId: request.agentId ? normalizeHex(request.agentId) : zeroHash,
      requestedAt: parseUint64String(request.requestedAt, 'requestedAt')
    }
  };
}

export function deriveAgentIdFromPubKey(agentPubKey: Hex): Hex {
  const bytes = encodeHexBytes(agentPubKey, 'agentPubKey');
  return sha256Hex(bytes);
}

export function isAuthorizationExpired(authorization: AuthorizationV1, nowUnixSeconds: bigint): boolean {
  return nowUnixSeconds > parseUint64String(authorization.expiresAt, 'expiresAt');
}

export function isExecutionWindowExpired(
  authorization: AuthorizationV1,
  nowUnixSeconds: bigint,
  graceSeconds: bigint
): boolean {
  const expiry = parseUint64String(authorization.expiresAt, 'expiresAt');
  return nowUnixSeconds > expiry + graceSeconds;
}

export interface AgentAuthorizationInvariantSample {
  agentNonce: string;
  amountMicros: string;
}

export function assertAgentAuthorizationInvariant(input: {
  creditedMicros: string;
  acceptedAuthorizations: readonly AgentAuthorizationInvariantSample[];
  expectedStartNonce?: string;
}): void {
  const credited = parseUint64String(input.creditedMicros, 'creditedMicros');
  let debited = 0n;
  let expectedNonce = parseUint64String(input.expectedStartNonce ?? '0', 'expectedStartNonce');

  for (const accepted of input.acceptedAuthorizations) {
    const nonce = parseUint64String(accepted.agentNonce, 'agentNonce');
    const amount = parseUint64String(accepted.amountMicros, 'amountMicros');

    if (nonce !== expectedNonce) {
      throw new Error(`agent nonce invariant violated: expected ${expectedNonce}, got ${nonce}`);
    }
    debited += amount;
    if (debited > credited) {
      throw new Error('debit invariant violated: cumulative debited exceeds credited balance');
    }
    expectedNonce += 1n;
  }
}
