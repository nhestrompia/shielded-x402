import { createHash } from 'node:crypto';
import type { Hex, PaymentRequirement, RelayerMerchantRequest, RelayerMerchantResult, ShieldedPaymentResponse } from './types.js';
import { normalizeHex } from './hex.js';

export type CreditChannelId = Hex;

export interface CreditDomainResponse {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
  relayerAddress: Hex;
}

export interface CreditState {
  channelId: CreditChannelId;
  seq: string;
  available: string;
  cumulativeSpent: string;
  lastDebitDigest: Hex;
  updatedAt: string;
  agentAddress: Hex;
  relayerAddress: Hex;
}

export interface SignedCreditState {
  state: CreditState;
  agentSignature: Hex;
  relayerSignature: Hex;
}

export interface CreditDebitIntent {
  channelId: CreditChannelId;
  prevStateHash: Hex;
  nextSeq: string;
  amount: string;
  merchantRequestHash: Hex;
  deadline: string;
  requestId: string;
}

export interface RelayerCreditTopupRequest {
  channelId: CreditChannelId;
  requestId: string;
  paymentPayload: ShieldedPaymentResponse;
  paymentPayloadSignature: Hex;
  latestState?: SignedCreditState;
}

export interface RelayerCreditTopupResponse {
  requestId: string;
  status: 'DONE' | 'FAILED';
  channelId: CreditChannelId;
  nextState?: CreditState;
  nextStateRelayerSignature?: Hex;
  settlementTxHash?: Hex;
  amountCredited?: string;
  settledNullifier?: Hex;
  failureReason?: string;
}

export interface RelayerCreditPayRequest {
  requestId: string;
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
  latestState: SignedCreditState;
  debitIntent: CreditDebitIntent;
  debitIntentSignature: Hex;
}

export interface RelayerCreditPayResponse {
  requestId: string;
  status: 'DONE' | 'FAILED';
  channelId: CreditChannelId;
  nextState?: CreditState;
  nextStateRelayerSignature?: Hex;
  merchantResult?: RelayerMerchantResult;
  failureReason?: string;
}

export interface CreditChannelStatus {
  channelId: CreditChannelId;
  exists: boolean;
  closing: boolean;
  agentAddress?: Hex;
  relayerAddress?: Hex;
  escrowed?: string;
  closeSeq?: string;
  challengeDeadline?: string;
  closeAvailable?: string;
  closeCumulativeSpent?: string;
  closeLastDebitDigest?: Hex;
  closeUpdatedAt?: string;
}

export interface RelayerCreditCloseStartRequest {
  latestState: SignedCreditState;
}

export interface RelayerCreditCloseStartResponse {
  status: 'DONE' | 'FAILED';
  channelId: CreditChannelId;
  txHash?: Hex;
  challengeDeadline?: string;
  failureReason?: string;
}

export interface RelayerCreditCloseChallengeRequest {
  higherState: SignedCreditState;
}

export interface RelayerCreditCloseChallengeResponse {
  status: 'DONE' | 'FAILED';
  channelId: CreditChannelId;
  txHash?: Hex;
  challengeDeadline?: string;
  failureReason?: string;
}

export interface RelayerCreditCloseFinalizeRequest {
  channelId: CreditChannelId;
}

export interface RelayerCreditCloseFinalizeResponse {
  status: 'DONE' | 'FAILED';
  channelId: CreditChannelId;
  txHash?: Hex;
  paidToAgent?: string;
  paidToRelayer?: string;
  failureReason?: string;
}

export const CREDIT_EIP712_NAME = 'shielded-x402-credit';
export const CREDIT_EIP712_VERSION = '1';
const CREDIT_CHANNEL_DERIVATION_NAMESPACE = 'shielded-x402-credit:channel:v1';

export const CREDIT_EIP712_TYPES = {
  CreditState: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
    { name: 'available', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'lastDebitDigest', type: 'bytes32' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'agentAddress', type: 'address' },
    { name: 'relayerAddress', type: 'address' }
  ],
  CreditDebitIntent: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'prevStateHash', type: 'bytes32' },
    { name: 'nextSeq', type: 'uint64' },
    { name: 'amount', type: 'uint256' },
    { name: 'merchantRequestHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' },
    { name: 'requestId', type: 'bytes32' }
  ]
} as const;

const EMPTY_BODY_HASH = sha256Hex(Buffer.alloc(0));

const REQUEST_HEADER_BLOCKLIST = new Set([
  'host',
  'content-length',
  'connection',
  'date',
  'user-agent',
  'payment-signature',
  'payment-required',
  'payment-response'
]);

function normalizeIntegerString(value: string): string {
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`expected non-negative integer string, got ${value}`);
  }
  return parsed.toString();
}

function sha256Hex(input: string | Buffer): Hex {
  return (`0x${createHash('sha256').update(input).digest('hex')}`) as Hex;
}

function normalizeUrl(input: string): string {
  const parsed = new URL(input);
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const isDefaultPort = (protocol === 'http:' && parsed.port === '80') || (protocol === 'https:' && parsed.port === '443');
  const port = parsed.port && !isDefaultPort ? `:${parsed.port}` : '';
  const pathname = parsed.pathname || '/';
  const searchEntries = [...parsed.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) return aValue.localeCompare(bValue);
    return aKey.localeCompare(bKey);
  });
  const search = new URLSearchParams(searchEntries).toString();
  return `${protocol}//${hostname}${port}${pathname}${search ? `?${search}` : ''}`;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Array<[string, string]> {
  if (!headers) return [];
  const normalized: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey.length === 0 || REQUEST_HEADER_BLOCKLIST.has(normalizedKey)) continue;
    normalized.push([normalizedKey, value.trim()]);
  }
  normalized.sort(([a], [b]) => a.localeCompare(b));
  return normalized;
}

function normalizeRequirementSubset(requirement: PaymentRequirement): {
  rail: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  challengeNonce: string;
  challengeExpiry: string;
  verifyingContract: string;
} {
  return {
    rail: requirement.rail.toLowerCase(),
    network: requirement.network.toLowerCase(),
    asset: String(requirement.asset).toLowerCase(),
    payTo: requirement.payTo.toLowerCase(),
    amount: normalizeIntegerString(requirement.amount),
    challengeNonce: requirement.challengeNonce.toLowerCase(),
    challengeExpiry: normalizeIntegerString(requirement.challengeExpiry),
    verifyingContract: requirement.verifyingContract.toLowerCase()
  };
}

function bodyHashFromBase64(bodyBase64: string | undefined): Hex {
  if (!bodyBase64) return EMPTY_BODY_HASH;
  const body = Buffer.from(bodyBase64, 'base64');
  return sha256Hex(body);
}

function requestIdDigest(requestId: string): Hex {
  const trimmed = requestId.trim();
  if (trimmed.length === 0) throw new Error('requestId must not be empty');
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return normalizeHex(trimmed);
  }
  return sha256Hex(trimmed);
}

export function canonicalMerchantRequestHash(input: {
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
}): Hex {
  const canonical = {
    method: input.merchantRequest.method.toUpperCase(),
    url: normalizeUrl(input.merchantRequest.url),
    headers: normalizeHeaders(input.merchantRequest.headers),
    bodySha256: bodyHashFromBase64(input.merchantRequest.bodyBase64),
    requirement: normalizeRequirementSubset(input.requirement)
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function hashCreditState(state: CreditState): Hex {
  const canonical = {
    channelId: state.channelId.toLowerCase(),
    seq: normalizeIntegerString(state.seq),
    available: normalizeIntegerString(state.available),
    cumulativeSpent: normalizeIntegerString(state.cumulativeSpent),
    lastDebitDigest: state.lastDebitDigest.toLowerCase(),
    updatedAt: normalizeIntegerString(state.updatedAt),
    agentAddress: state.agentAddress.toLowerCase(),
    relayerAddress: state.relayerAddress.toLowerCase()
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function hashCreditDebitIntent(intent: CreditDebitIntent): Hex {
  const canonical = {
    channelId: intent.channelId.toLowerCase(),
    prevStateHash: intent.prevStateHash.toLowerCase(),
    nextSeq: normalizeIntegerString(intent.nextSeq),
    amount: normalizeIntegerString(intent.amount),
    merchantRequestHash: intent.merchantRequestHash.toLowerCase(),
    deadline: normalizeIntegerString(intent.deadline),
    requestId: requestIdDigest(intent.requestId)
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function deriveCreditChannelId(input: {
  domain: CreditDomainResponse;
  agentAddress: Hex;
}): CreditChannelId {
  const canonical = {
    namespace: CREDIT_CHANNEL_DERIVATION_NAMESPACE,
    chainId: input.domain.chainId,
    verifyingContract: input.domain.verifyingContract.toLowerCase(),
    relayerAddress: input.domain.relayerAddress.toLowerCase(),
    agentAddress: input.agentAddress.toLowerCase()
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function toEip712Domain(domain: CreditDomainResponse): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
} {
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract
  };
}

export function toCreditStateTypedData(state: CreditState): {
  channelId: Hex;
  seq: bigint;
  available: bigint;
  cumulativeSpent: bigint;
  lastDebitDigest: Hex;
  updatedAt: bigint;
  agentAddress: Hex;
  relayerAddress: Hex;
} {
  return {
    channelId: state.channelId,
    seq: BigInt(state.seq),
    available: BigInt(state.available),
    cumulativeSpent: BigInt(state.cumulativeSpent),
    lastDebitDigest: state.lastDebitDigest,
    updatedAt: BigInt(state.updatedAt),
    agentAddress: state.agentAddress,
    relayerAddress: state.relayerAddress
  };
}

export function toCreditDebitIntentTypedData(intent: CreditDebitIntent): {
  channelId: Hex;
  prevStateHash: Hex;
  nextSeq: bigint;
  amount: bigint;
  merchantRequestHash: Hex;
  deadline: bigint;
  requestId: Hex;
} {
  return {
    channelId: intent.channelId,
    prevStateHash: intent.prevStateHash,
    nextSeq: BigInt(intent.nextSeq),
    amount: BigInt(intent.amount),
    merchantRequestHash: intent.merchantRequestHash,
    deadline: BigInt(intent.deadline),
    requestId: requestIdDigest(intent.requestId)
  };
}

function buildTypedDataPayload<
  TPrimaryType extends 'CreditState' | 'CreditDebitIntent',
  TMessage extends ReturnType<typeof toCreditStateTypedData> | ReturnType<typeof toCreditDebitIntentTypedData>
>(
  domain: CreditDomainResponse,
  primaryType: TPrimaryType,
  message: TMessage
): {
  domain: ReturnType<typeof toEip712Domain>;
  types: typeof CREDIT_EIP712_TYPES;
  primaryType: TPrimaryType;
  message: TMessage;
} {
  return {
    domain: toEip712Domain(domain),
    types: CREDIT_EIP712_TYPES,
    primaryType,
    message
  };
}

export function buildCreditStateTypedDataPayload(domain: CreditDomainResponse, state: CreditState): {
  domain: ReturnType<typeof toEip712Domain>;
  types: typeof CREDIT_EIP712_TYPES;
  primaryType: 'CreditState';
  message: ReturnType<typeof toCreditStateTypedData>;
} {
  return buildTypedDataPayload(domain, 'CreditState', toCreditStateTypedData(state));
}

export function buildCreditDebitIntentTypedDataPayload(
  domain: CreditDomainResponse,
  intent: CreditDebitIntent
): {
  domain: ReturnType<typeof toEip712Domain>;
  types: typeof CREDIT_EIP712_TYPES;
  primaryType: 'CreditDebitIntent';
  message: ReturnType<typeof toCreditDebitIntentTypedData>;
} {
  return buildTypedDataPayload(domain, 'CreditDebitIntent', toCreditDebitIntentTypedData(intent));
}
