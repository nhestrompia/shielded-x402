import {
  X402_HEADERS,
  encodeX402Header,
  parsePaymentRequiredEnvelope,
  parsePaymentRequiredHeader,
  type PaymentRequirement,
  type X402PaymentRequired,
  type RelayerMerchantRequest
} from '@shielded-x402/shared-types';
import type { ChallengeFetcher } from './types.js';

function getRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getIntegerString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed)) && Number(trimmed) >= 0) {
      return Math.trunc(Number(trimmed)).toString();
    }
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString();
  }
  return undefined;
}

function normalizeRequirementLike(
  input: Record<string, unknown>,
  fallbackResource: string
): Record<string, unknown> | undefined {
  const extra = getRecord(input.extra);
  const scheme = (getString(input, 'scheme') ?? getString(extra ?? {}, 'scheme') ?? 'exact').toLowerCase();
  const network = getString(input, 'network') ?? getString(extra ?? {}, 'network');
  const payTo = getString(input, 'payTo') ?? getString(input, 'to') ?? getString(extra ?? {}, 'payTo');
  const asset = getString(input, 'asset') ?? getString(extra ?? {}, 'asset');
  const amount =
    getIntegerString(input, 'amount') ??
    getIntegerString(input, 'maxAmountRequired') ??
    getIntegerString(extra ?? {}, 'amount') ??
    getIntegerString(extra ?? {}, 'maxAmountRequired');

  if (!scheme || !network || !payTo || !asset || !amount) return undefined;

  const normalized: Record<string, unknown> = {
    scheme,
    network,
    amount,
    payTo,
    asset
  };
  normalized.resource = getString(input, 'resource') ?? getString(extra ?? {}, 'resource') ?? fallbackResource;
  const description = getString(input, 'description') ?? getString(extra ?? {}, 'description');
  if (description) normalized.description = description;
  const mimeType = getString(input, 'mimeType') ?? getString(extra ?? {}, 'mimeType');
  if (mimeType) normalized.mimeType = mimeType;
  const rail = getString(input, 'rail') ?? getString(extra ?? {}, 'rail');
  const challengeNonce =
    getString(input, 'challengeNonce') ?? getString(extra ?? {}, 'challengeNonce');
  const challengeExpiry =
    getString(input, 'challengeExpiry') ?? getString(extra ?? {}, 'challengeExpiry');
  const merchantPubKey =
    getString(input, 'merchantPubKey') ?? getString(extra ?? {}, 'merchantPubKey');
  const verifyingContract =
    getString(input, 'verifyingContract') ?? getString(extra ?? {}, 'verifyingContract');
  if (rail && challengeNonce && challengeExpiry && merchantPubKey && verifyingContract) {
    normalized.rail = rail;
    normalized.challengeNonce = challengeNonce;
    normalized.challengeExpiry = challengeExpiry;
    normalized.merchantPubKey = merchantPubKey;
    normalized.verifyingContract = verifyingContract;
  }
  const maxTimeoutSeconds = input.maxTimeoutSeconds ?? extra?.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds === 'number' && Number.isFinite(maxTimeoutSeconds)) {
    normalized.maxTimeoutSeconds = Math.trunc(maxTimeoutSeconds);
  }
  if (input.outputSchema !== undefined) normalized.outputSchema = input.outputSchema;
  if (extra) normalized.extra = extra;
  return normalized;
}

async function parseRequirementHeaderFromResponse(
  response: Response,
  fallbackResource: string
): Promise<string> {
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (!header) {
    let bodyRecord: Record<string, unknown> | undefined;
    try {
      bodyRecord = getRecord((await response.clone().json()) as unknown);
    } catch {
      bodyRecord = undefined;
    }
    if (!bodyRecord) {
      throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
    }

    const candidates: unknown[] = [];
    if (Array.isArray(bodyRecord.accepts)) candidates.push(...bodyRecord.accepts);
    if (Array.isArray(bodyRecord.requirements)) candidates.push(...bodyRecord.requirements);
    if (candidates.length === 0) candidates.push(bodyRecord);

    const normalizedAccept = candidates
      .map((entry) => getRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => normalizeRequirementLike(entry, fallbackResource))
      .find((entry): entry is Record<string, unknown> => Boolean(entry));
    if (!normalizedAccept) {
      throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
    }

    const envelope: X402PaymentRequired = {
      x402Version: 2,
      accepts: [normalizedAccept],
      ...(typeof bodyRecord.error === 'string' ? { error: bodyRecord.error } : {})
    };
    const synthesized = encodeX402Header(envelope);
    parsePaymentRequiredEnvelope(synthesized);
    return synthesized;
  }
  parsePaymentRequiredEnvelope(header);
  return header;
}

export function createChallengeFetcher(fetchImpl: typeof fetch = fetch): ChallengeFetcher {
  const fetchRequirementHeader = async (merchantRequest: RelayerMerchantRequest): Promise<string> => {
    const candidates = [merchantRequest.challengeUrl, merchantRequest.url].filter(
      (value): value is string => Boolean(value)
    );

    for (const candidate of candidates) {
      const response = await fetchImpl(candidate, {
        method: 'GET',
        headers: {
          accept: 'application/json'
        }
      });
      return parseRequirementHeaderFromResponse(response, candidate);
    }

    throw new Error('unable to fetch merchant payment requirement');
  };

  return {
    fetchRequirementHeader,
    fetchRequirement: async (merchantRequest: RelayerMerchantRequest): Promise<PaymentRequirement> => {
      const header = await fetchRequirementHeader(merchantRequest);
      return parsePaymentRequiredHeader(header);
    }
  };
}

export function requirementsMatch(expected: PaymentRequirement, actual: PaymentRequirement): boolean {
  return (
    expected.scheme === actual.scheme &&
    expected.network === actual.network &&
    expected.asset.toLowerCase() === actual.asset.toLowerCase() &&
    expected.payTo.toLowerCase() === actual.payTo.toLowerCase() &&
    expected.rail === actual.rail &&
    expected.amount === actual.amount &&
    expected.challengeNonce.toLowerCase() === actual.challengeNonce.toLowerCase() &&
    expected.challengeExpiry === actual.challengeExpiry &&
    expected.merchantPubKey.toLowerCase() === actual.merchantPubKey.toLowerCase() &&
    expected.verifyingContract.toLowerCase() === actual.verifyingContract.toLowerCase()
  );
}
