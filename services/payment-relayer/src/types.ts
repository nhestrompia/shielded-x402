import type {
  CreditChannelStatus,
  CreditDomainResponse,
  CreditState,
  Hex,
  PaymentRequirement,
  RelayerCreditCloseChallengeRequest,
  RelayerCreditCloseChallengeResponse,
  RelayerCreditCloseFinalizeRequest,
  RelayerCreditCloseFinalizeResponse,
  RelayerCreditCloseStartRequest,
  RelayerCreditCloseStartResponse,
  RelayerCreditPayRequest,
  RelayerCreditPayResponse,
  RelayerCreditTopupRequest,
  RelayerCreditTopupResponse,
  RelayerMerchantRequest,
  RelayerMerchantResult,
  ShieldedPaymentResponse
} from '@shielded-x402/shared-types';

export interface VerifierAdapter {
  verifyProof: (payload: ShieldedPaymentResponse) => Promise<boolean>;
  isNullifierUsed: (nullifier: Hex) => Promise<boolean>;
}

export interface SettlementAdapter {
  settleOnchain: (
    payload: ShieldedPaymentResponse
  ) => Promise<{
    txHash?: Hex;
    alreadySettled: boolean;
    merchantLeafIndex?: number;
    changeLeafIndex?: number;
    newRoot?: Hex;
  }>;
}

export interface PayoutRequest {
  settlementId: string;
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
  nullifier: Hex;
  settlementTxHash?: Hex;
}

export interface PayoutAdapter {
  payMerchant: (request: PayoutRequest) => Promise<RelayerMerchantResult>;
}

export interface CreditRelayerProcessor {
  domain: () => CreditDomainResponse;
  handleTopup: (request: RelayerCreditTopupRequest) => Promise<RelayerCreditTopupResponse>;
  handlePay: (request: RelayerCreditPayRequest) => Promise<RelayerCreditPayResponse>;
  handleCloseStart: (
    request: RelayerCreditCloseStartRequest
  ) => Promise<RelayerCreditCloseStartResponse>;
  handleCloseChallenge: (
    request: RelayerCreditCloseChallengeRequest
  ) => Promise<RelayerCreditCloseChallengeResponse>;
  handleCloseFinalize: (
    request: RelayerCreditCloseFinalizeRequest
  ) => Promise<RelayerCreditCloseFinalizeResponse>;
  getCloseStatus: (channelId: Hex) => Promise<CreditChannelStatus>;
}

export interface CreditSettlementAdapter {
  openOrTopup: (params: {
    channelId: Hex;
    agentAddress: Hex;
    amount: bigint;
  }) => Promise<{ txHash: Hex }>;
  startClose: (params: {
    signedState: {
      state: CreditState;
      agentSignature: Hex;
      relayerSignature: Hex;
    };
  }) => Promise<{ txHash: Hex; challengeDeadline: bigint }>;
  challengeClose: (params: {
    signedState: {
      state: CreditState;
      agentSignature: Hex;
      relayerSignature: Hex;
    };
  }) => Promise<{ txHash: Hex; challengeDeadline: bigint }>;
  finalizeClose: (params: { channelId: Hex }) => Promise<{ txHash: Hex; paidToAgent: bigint; paidToRelayer: bigint }>;
  getChannel: (params: { channelId: Hex }) => Promise<CreditChannelStatus>;
}

export interface CreditChannelHeadStore {
  get: (channelId: Hex) => Promise<CreditState | undefined>;
  put: (state: CreditState) => Promise<void>;
  delete: (channelId: Hex) => Promise<void>;
}

export interface CreditRelayerProcessorConfig {
  verifier: VerifierAdapter;
  settlement: SettlementAdapter;
  payout: PayoutAdapter;
  creditSettlement?: CreditSettlementAdapter;
  headStore?: CreditChannelHeadStore;
  creditDomain: CreditDomainResponse;
  relayerPrivateKey: Hex;
  now?: () => number;
}

export interface CreditTopupCacheRecord {
  requestId: string;
  response: RelayerCreditTopupResponse;
}

export interface CreditPayCacheRecord {
  requestId: string;
  response: RelayerCreditPayResponse;
}
