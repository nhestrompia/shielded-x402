export type Hex = `0x${string}`;

export interface ShieldedNote {
  amount: bigint;
  rho: Hex;
  pkHash: Hex;
  commitment: Hex;
  leafIndex: number;
}

export interface SpendPublicInputs {
  nullifier: Hex;
  root: Hex;
  merchantCommitment: Hex;
  changeCommitment: Hex;
  challengeHash: Hex;
  amount: bigint;
}

export interface ShieldedPaymentResponse {
  proof: Hex;
  publicInputs: Hex[];
  nullifier: Hex;
  root: Hex;
  merchantCommitment: Hex;
  changeCommitment: Hex;
  challengeHash: Hex;
  encryptedReceipt: Hex;
  txHint?: string;
}

export interface PaymentRequirement {
  x402Version?: 2;
  scheme: 'exact' | string;
  network: string;
  asset: Hex | string;
  payTo: Hex;
  rail: 'shielded-usdc' | string;
  amount: string;
  challengeNonce: string;
  challengeExpiry: string;
  merchantPubKey: Hex;
  verifyingContract: Hex;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  outputSchema?: string;
  extra?: Record<string, string> & {
    rail: 'shielded-usdc' | string;
    challengeNonce: string;
    challengeExpiry: string;
    merchantPubKey: Hex;
    verifyingContract: Hex;
  };
}

export interface X402PaymentRequired {
  x402Version: 2;
  accepts: Array<Record<string, unknown>>;
  error?: string;
}

export interface X402PaymentSignaturePayload {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: ShieldedPaymentResponse;
  challengeNonce: Hex;
  signature: Hex;
}

export interface AgentRecord {
  did: string;
  endpoint: string;
  encryptionPubKey: Hex;
  capabilities: string[];
  supportedRails: string[];
  signature: Hex;
}

export interface ReputationSignal {
  successfulSettlements: number;
  disputes: number;
  uptime: number;
  attestationRefs: string[];
}

export interface RelayerMerchantRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  challengeUrl?: string;
}

export interface RelayerPayRequest {
  merchantRequest: RelayerMerchantRequest;
  requirement: PaymentRequirement;
  paymentSignatureHeader: string;
  idempotencyKey?: string;
}

export interface RelayerChallengeRequest {
  merchantRequest: RelayerMerchantRequest;
  merchantPaymentRequiredHeader?: string;
}

export interface RelayerChallengeResponse {
  requirement: PaymentRequirement;
  paymentRequiredHeader: string;
  upstreamRequirementHash: Hex;
}

export type RelayerSettlementStatus =
  | 'RECEIVED'
  | 'VERIFIED'
  | 'SENT_ONCHAIN'
  | 'CONFIRMED'
  | 'PAID_MERCHANT'
  | 'DONE'
  | 'FAILED';

export interface RelayerMerchantResult {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  payoutReference?: string;
}

export interface RelayerSettlementDelta {
  merchantCommitment: Hex;
  changeCommitment: Hex;
  merchantLeafIndex?: number;
  changeLeafIndex?: number;
  newRoot?: Hex;
}

export interface RelayerPayResponse {
  settlementId: string;
  status: RelayerSettlementStatus;
  nullifier: Hex;
  settlementTxHash?: Hex;
  settlementDelta?: RelayerSettlementDelta;
  merchantResult?: RelayerMerchantResult;
  failureReason?: string;
}

export type ServiceProtocol = 'a2a' | 'mcp' | 'web' | 'oasf' | 'email' | 'ens' | 'did';

export interface CanonicalServiceEndpoint {
  protocol: ServiceProtocol;
  url?: string;
  identifier?: string;
  version?: string;
  capabilities?: string[];
  raw?: Record<string, unknown>;
}

export type TrustDataSource = 'onchain' | 'indexer' | 'merged';

export interface CanonicalTrustSnapshot {
  snapshotTimestamp: string;
  source: TrustDataSource;
  score?: number;
  healthStatus?: 'healthy' | 'degraded' | 'unknown';
  feedbackCount?: number;
  avgFeedbackScore?: number;
  lastActiveAt?: string;
  parseStatus?: 'success' | 'warning' | 'error';
  raw?: Record<string, unknown>;
}

export interface CanonicalAgentProfile {
  chainId: number;
  tokenId: string;
  registryAddress?: Hex;
  ownerAddress?: Hex;
  name?: string;
  description?: string;
  imageUrl?: string;
  x402Supported?: boolean;
  services: CanonicalServiceEndpoint[];
  trust?: CanonicalTrustSnapshot;
  sourceMetadata: {
    onchainResolved: boolean;
    indexerResolved: boolean;
  };
  raw?: Record<string, unknown>;
}

export interface CounterpartyCandidate {
  endpoint: CanonicalServiceEndpoint;
  rankScore: number;
  rejectionReasons: string[];
  rankScoreBreakdown: Record<string, number>;
}

export interface CounterpartySelectionResult {
  selected?: CounterpartyCandidate;
  candidates: CounterpartyCandidate[];
}

export type AgentPaymentErrorCode =
  | 'E_DIRECTORY_UNAVAILABLE'
  | 'E_AGENT_NOT_FOUND'
  | 'E_NO_COMPATIBLE_ENDPOINT'
  | 'E_402_NORMALIZATION_FAILED'
  | 'E_PAYMENT_EXECUTION_FAILED';

export interface TrustSnapshotMetadata {
  providerName: string;
  fetchedAt: string;
}

export interface RequirementAdapterContext {
  requestUrl: string;
  selectedEndpoint?: CanonicalServiceEndpoint;
  cachedRequirement?: Record<string, unknown>;
}
