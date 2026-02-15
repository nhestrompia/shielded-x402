import {
  X402_HEADERS,
  parsePaymentRequiredHeader,
  type PaymentRequirement,
  type RelayerMerchantRequest
} from '@shielded-x402/shared-types';
import type { ChallengeFetcher } from './types.js';

function parseRequirementFromResponse(response: Response): PaymentRequirement {
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (!header) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }
  return parsePaymentRequiredHeader(header);
}

export function createChallengeFetcher(fetchImpl: typeof fetch = fetch): ChallengeFetcher {
  return {
    fetchRequirement: async (merchantRequest: RelayerMerchantRequest): Promise<PaymentRequirement> => {
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
        return parseRequirementFromResponse(response);
      }

      throw new Error('unable to fetch merchant payment requirement');
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
