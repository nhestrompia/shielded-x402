import {
  RELAYER_ROUTES,
  type CreditChannelStatus,
  type Hex,
  type RelayerCreditCloseChallengeResponse,
  type RelayerCreditCloseFinalizeResponse,
  type RelayerCreditCloseStartResponse,
  type SignedCreditState
} from '@shielded-x402/shared-types';
import { postJson, requestJson } from './http.js';

export interface CreditCloseClientConfig {
  relayerEndpoint: string;
  fetchImpl?: typeof fetch;
}

export interface CreditCloseClient {
  startClose: (latestState: SignedCreditState) => Promise<RelayerCreditCloseStartResponse>;
  challengeClose: (higherState: SignedCreditState) => Promise<RelayerCreditCloseChallengeResponse>;
  finalizeClose: (channelId: Hex) => Promise<RelayerCreditCloseFinalizeResponse>;
  getCloseStatus: (channelId: Hex) => Promise<CreditChannelStatus>;
}

export function createCreditCloseClient(config: CreditCloseClientConfig): CreditCloseClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = config.relayerEndpoint.replace(/\/$/, '');

  return {
    startClose: async (latestState) => {
      return postJson<RelayerCreditCloseStartResponse>(
        fetchImpl,
        `${endpoint}${RELAYER_ROUTES.creditCloseStart}`,
        { latestState },
        { allowNonOk: true }
      );
    },
    challengeClose: async (higherState) => {
      return postJson<RelayerCreditCloseChallengeResponse>(
        fetchImpl,
        `${endpoint}${RELAYER_ROUTES.creditCloseChallenge}`,
        { higherState },
        { allowNonOk: true }
      );
    },
    finalizeClose: async (channelId) => {
      return postJson<RelayerCreditCloseFinalizeResponse>(
        fetchImpl,
        `${endpoint}${RELAYER_ROUTES.creditCloseFinalize}`,
        { channelId },
        { allowNonOk: true }
      );
    },
    getCloseStatus: async (channelId) => {
      return requestJson<CreditChannelStatus>(
        fetchImpl,
        `${endpoint}${RELAYER_ROUTES.creditCloseStatusPrefix}/${channelId}`,
        { method: 'GET', errorPrefix: 'failed to fetch close status' }
      );
    }
  };
}
