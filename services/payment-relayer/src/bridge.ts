import { createHash, randomBytes } from 'node:crypto';
import {
  buildPaymentRequiredHeader,
  parsePaymentRequiredEnvelope,
  type Hex,
  type PaymentRequirement,
  type RelayerChallengeRequest,
  type RelayerChallengeResponse,
  type RelayerMerchantRequest
} from '@shielded-x402/shared-types';
import type { ChallengeFetcher } from './types.js';

interface UpstreamTerms {
  scheme: string;
  network: string;
  asset: string;
  payTo: Hex;
  amount: string;
  rail?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: string;
}

export interface ShieldedChallengeBridgeConfig {
  challengeFetcher: ChallengeFetcher;
  challengeTtlMs: number;
  merchantPubKey: Hex;
  verifyingContract: Hex;
  now?: () => number;
  randomNonceHex?: () => Hex;
}

function sha256Hex32(value: string): Hex {
  return `0x${createHash('sha256').update(value).digest('hex')}` as Hex;
}

function toLowerHex(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function stringifyOutputSchema(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseUpstreamTermsFromRequirement(raw: Record<string, unknown>): UpstreamTerms {
  const scheme = getString(raw, 'scheme');
  const network = getString(raw, 'network');
  const asset = getString(raw, 'asset');
  const payTo = getString(raw, 'payTo');
  const amount = getString(raw, 'amount') ?? getString(raw, 'maxAmountRequired');

  if (!scheme || !network || !asset || !payTo || !amount) {
    throw new Error('merchant PAYMENT-REQUIRED is missing required x402 fields');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error('merchant payTo must be an EVM address');
  }

  const terms: UpstreamTerms = {
    scheme,
    network,
    asset,
    payTo: payTo as Hex,
    amount
  };
  const rail = getString(raw, 'rail');
  const description = getString(raw, 'description');
  const mimeType = getString(raw, 'mimeType');
  const outputSchema = stringifyOutputSchema(raw.outputSchema);
  if (rail) terms.rail = rail;
  if (description) terms.description = description;
  if (mimeType) terms.mimeType = mimeType;
  if (outputSchema) terms.outputSchema = outputSchema;
  return terms;
}

export function upstreamTermsHash(terms: UpstreamTerms): Hex {
  const canonical = [
    terms.scheme,
    terms.network,
    terms.asset.toLowerCase(),
    terms.payTo.toLowerCase(),
    terms.amount
  ].join('|');
  return sha256Hex32(canonical);
}

export function upstreamTermsHashFromHeader(paymentRequiredHeader: string): Hex {
  const envelope = parsePaymentRequiredEnvelope(paymentRequiredHeader);
  const accepted = envelope.accepts[0];
  if (!accepted || typeof accepted !== 'object') {
    throw new Error('merchant PAYMENT-REQUIRED has no accepted requirement');
  }
  const terms = parseUpstreamTermsFromRequirement(accepted as Record<string, unknown>);
  return upstreamTermsHash(terms);
}

export function merchantRequestHash(request: RelayerMerchantRequest): Hex {
  const canonical = JSON.stringify({
    url: request.url,
    method: request.method.toUpperCase(),
    challengeUrl: request.challengeUrl ?? ''
  });
  return sha256Hex32(canonical);
}

function defaultRandomNonceHex(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

export function createShieldedChallengeBridge(config: ShieldedChallengeBridgeConfig) {
  const now = config.now ?? Date.now;
  const randomNonceHex = config.randomNonceHex ?? defaultRandomNonceHex;

  return {
    issueChallenge: async (request: RelayerChallengeRequest): Promise<RelayerChallengeResponse> => {
      const fetchedHeader = await config.challengeFetcher.fetchRequirementHeader(request.merchantRequest);
      const fetchedEnvelope = parsePaymentRequiredEnvelope(fetchedHeader);
      const accepted = fetchedEnvelope.accepts[0];
      if (!accepted || typeof accepted !== 'object') {
        throw new Error('merchant PAYMENT-REQUIRED has no accepted requirement');
      }
      const terms = parseUpstreamTermsFromRequirement(accepted as Record<string, unknown>);
      const fetchedTermsHash = upstreamTermsHash(terms);

      if (request.merchantPaymentRequiredHeader) {
        const providedTermsHash = upstreamTermsHashFromHeader(request.merchantPaymentRequiredHeader);
        if (toLowerHex(providedTermsHash) !== toLowerHex(fetchedTermsHash)) {
          throw new Error('merchant requirement drift detected between client and relayer');
        }
      }

      const challengeNonce = randomNonceHex();
      const challengeExpiry = String(now() + config.challengeTtlMs);
      const requestHash = merchantRequestHash(request.merchantRequest);

      const requirement: PaymentRequirement = {
        x402Version: 2,
        scheme: terms.scheme,
        network: terms.network,
        asset: terms.asset,
        payTo: terms.payTo,
        rail: 'shielded-usdc',
        amount: terms.amount,
        challengeNonce,
        challengeExpiry,
        merchantPubKey: config.merchantPubKey,
        verifyingContract: config.verifyingContract,
        ...(terms.description ? { description: terms.description } : {}),
        ...(terms.mimeType ? { mimeType: terms.mimeType } : {}),
        ...(terms.outputSchema ? { outputSchema: terms.outputSchema } : {}),
        extra: {
          rail: 'shielded-usdc',
          challengeNonce,
          challengeExpiry,
          merchantPubKey: config.merchantPubKey,
          verifyingContract: config.verifyingContract,
          upstreamTermsHash: fetchedTermsHash,
          merchantRequestHash: requestHash,
          ...(terms.rail ? { upstreamRail: terms.rail } : {})
        }
      };

      return {
        requirement,
        paymentRequiredHeader: buildPaymentRequiredHeader(requirement),
        upstreamRequirementHash: fetchedTermsHash
      };
    }
  };
}
