import type {
  PaymentRequirement,
  X402PaymentRequired,
  X402PaymentSignaturePayload
} from './types.js';

export const X402_HEADERS = {
  paymentRequired: 'PAYMENT-REQUIRED',
  paymentSignature: 'PAYMENT-SIGNATURE',
  paymentResponse: 'PAYMENT-RESPONSE'
} as const;

export const RELAYER_ROUTES = {
  pay: '/v1/relay/pay',
  statusPrefix: '/v1/relay/status'
} as const;

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function fromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

export function encodeX402Header<T>(value: T): string {
  return toBase64(JSON.stringify(value));
}

export function decodeX402Header<T>(rawHeader: string): T {
  const decoded = fromBase64(rawHeader.trim());
  return JSON.parse(decoded) as T;
}

export function buildPaymentRequiredHeader(requirement: PaymentRequirement): string {
  const envelope: X402PaymentRequired = {
    x402Version: 2,
    accepts: [
      {
        ...requirement,
        x402Version: 2,
        extra: requirement.extra ?? {
          rail: requirement.rail,
          challengeNonce: requirement.challengeNonce,
          challengeExpiry: requirement.challengeExpiry,
          merchantPubKey: requirement.merchantPubKey,
          verifyingContract: requirement.verifyingContract
        }
      }
    ]
  };
  return encodeX402Header(envelope);
}

export function parsePaymentRequiredHeader(rawHeader: string): PaymentRequirement {
  const envelope = decodeX402Header<X402PaymentRequired>(rawHeader);
  if (envelope.x402Version !== 2) {
    throw new Error('unsupported x402 version in PAYMENT-REQUIRED');
  }
  const accepted = envelope.accepts[0];
  if (!accepted) {
    throw new Error('x402 PAYMENT-REQUIRED has no accepted payment requirements');
  }
  return normalizeRequirement(accepted);
}

export function buildPaymentSignatureHeader(payload: X402PaymentSignaturePayload): string {
  return encodeX402Header(payload);
}

export function parsePaymentSignatureHeader(rawHeader: string): X402PaymentSignaturePayload {
  const envelope = decodeX402Header<X402PaymentSignaturePayload>(rawHeader);
  if (envelope.x402Version !== 2) {
    throw new Error('unsupported x402 version in PAYMENT-SIGNATURE');
  }
  return envelope;
}

export function normalizeRequirement(requirement: PaymentRequirement): PaymentRequirement {
  const extra = requirement.extra;
  const rail = requirement.rail ?? extra?.rail;
  const challengeNonce = requirement.challengeNonce ?? extra?.challengeNonce;
  const challengeExpiry = requirement.challengeExpiry ?? extra?.challengeExpiry;
  const merchantPubKey = requirement.merchantPubKey ?? extra?.merchantPubKey;
  const verifyingContract = requirement.verifyingContract ?? extra?.verifyingContract;

  if (!rail || !challengeNonce || !challengeExpiry || !merchantPubKey || !verifyingContract) {
    throw new Error('payment requirement missing shielded rail metadata');
  }

  return {
    ...requirement,
    x402Version: 2,
    rail,
    challengeNonce,
    challengeExpiry,
    merchantPubKey,
    verifyingContract,
    extra: {
      rail,
      challengeNonce,
      challengeExpiry,
      merchantPubKey,
      verifyingContract
    }
  };
}
