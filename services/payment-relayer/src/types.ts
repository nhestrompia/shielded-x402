import type {
  Hex,
  PaymentRequirement,
  RelayerMerchantRequest,
  RelayerMerchantResult,
  RelayerPayRequest,
  RelayerPayResponse,
  RelayerSettlementStatus,
  ShieldedPaymentResponse
} from '@shielded-x402/shared-types';

export interface ParsedRelayerRequest {
  settlementId: string;
  idempotencyKey: string;
  request: RelayerPayRequest;
  payload: ShieldedPaymentResponse;
}

export interface SettlementRecord extends RelayerPayResponse {
  idempotencyKey: string;
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
  payerAddress?: Hex;
  createdAt: number;
  updatedAt: number;
}

export interface SettlementStore {
  getBySettlementId: (settlementId: string) => Promise<SettlementRecord | undefined>;
  getByIdempotencyKey: (idempotencyKey: string) => Promise<SettlementRecord | undefined>;
  put: (record: SettlementRecord) => Promise<void>;
}

export interface VerifierAdapter {
  verifyProof: (payload: ShieldedPaymentResponse) => Promise<boolean>;
  isNullifierUsed: (nullifier: Hex) => Promise<boolean>;
}

export interface SettlementAdapter {
  settleOnchain: (payload: ShieldedPaymentResponse) => Promise<{ txHash?: Hex; alreadySettled: boolean }>;
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

export interface ChallengeFetcher {
  fetchRequirement: (merchantRequest: RelayerMerchantRequest) => Promise<PaymentRequirement>;
}

export interface RelayerProcessor {
  handlePay: (request: RelayerPayRequest) => Promise<SettlementRecord>;
  getStatus: (settlementId: string) => Promise<SettlementRecord | undefined>;
}

export interface PaymentRelayerProcessorConfig {
  store: SettlementStore;
  verifier: VerifierAdapter;
  settlement: SettlementAdapter;
  payout: PayoutAdapter;
  challengeFetcher: ChallengeFetcher;
  now?: () => number;
}

export const TERMINAL_STATES: ReadonlySet<RelayerSettlementStatus> = new Set([
  'DONE',
  'FAILED'
]);

export function withStatus(
  record: SettlementRecord,
  status: RelayerSettlementStatus,
  patch?: Partial<SettlementRecord>
): SettlementRecord {
  return {
    ...record,
    ...patch,
    status,
    updatedAt: patch?.updatedAt ?? Date.now()
  };
}
