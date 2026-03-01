import type {
  AuthorizeRequestV1,
  AuthorizeResponseV1,
  CommitmentMetadataV1,
  InclusionProofV1,
  ReclaimRequestV1,
  RelayPayRequestV1,
  RelayPayResponseV1
} from '@shielded-x402/shared-types';
import { RELAYER_ROUTES_V1, SEQUENCER_ROUTES_V1, type Hex } from '@shielded-x402/shared-types';
import { postJson, requestJson } from './http.js';

export interface MultiChainCreditClientConfig {
  sequencerUrl: string;
  relayerUrls: Record<string, string>;
  fetchImpl?: typeof fetch;
  sequencerAdminToken?: string;
}

export interface AdminCreditRequestV1 {
  agentId: Hex;
  amountMicros: string;
}

export interface AdminCreditResponseV1 {
  ok: boolean;
  agentId: Hex;
  creditedMicros: string;
}

export interface LatestCommitmentResponseV1 {
  latestEpochId: string;
  root: Hex;
  count?: number;
  prevRoot?: Hex;
  sequencerKeyId?: string;
  postedAt?: string | null;
  postedTxHash?: Hex | null;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export class MultiChainCreditClient {
  private readonly sequencerUrl: string;
  private readonly relayerUrls: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sequencerAdminToken: string | undefined;

  constructor(config: MultiChainCreditClientConfig) {
    this.sequencerUrl = trimTrailingSlash(config.sequencerUrl);
    this.relayerUrls = Object.fromEntries(
      Object.entries(config.relayerUrls).map(([chainRef, url]) => [chainRef, trimTrailingSlash(url)])
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sequencerAdminToken = config.sequencerAdminToken;
  }

  async authorize(request: AuthorizeRequestV1): Promise<AuthorizeResponseV1> {
    return postJson<AuthorizeResponseV1>(
      this.fetchImpl,
      `${this.sequencerUrl}${SEQUENCER_ROUTES_V1.authorize}`,
      request,
      { errorPrefix: 'authorize failed' }
    );
  }

  async relayPay(request: RelayPayRequestV1): Promise<RelayPayResponseV1> {
    const chainRef = request.authorization.chainRef;
    const relayerUrl = this.relayerUrls[chainRef];
    if (!relayerUrl) {
      throw new Error(`no relayer configured for chainRef ${chainRef}`);
    }
    return postJson<RelayPayResponseV1>(
      this.fetchImpl,
      `${relayerUrl}${RELAYER_ROUTES_V1.pay}`,
      request,
      { errorPrefix: 'relay pay failed' }
    );
  }

  async reclaim(request: ReclaimRequestV1): Promise<{ ok: true; authId: Hex }> {
    return postJson<{ ok: true; authId: Hex }>(
      this.fetchImpl,
      `${this.sequencerUrl}${SEQUENCER_ROUTES_V1.reclaim}`,
      request,
      { errorPrefix: 'reclaim failed' }
    );
  }

  async latestCommitment(): Promise<LatestCommitmentResponseV1> {
    return requestJson<LatestCommitmentResponseV1>(
      this.fetchImpl,
      `${this.sequencerUrl}${SEQUENCER_ROUTES_V1.commitmentsLatest}`,
      { errorPrefix: 'latest commitment failed' }
    );
  }

  async commitmentProof(authId: Hex): Promise<InclusionProofV1> {
    const query = new URLSearchParams({ authId }).toString();
    return requestJson<InclusionProofV1>(
      this.fetchImpl,
      `${this.sequencerUrl}${SEQUENCER_ROUTES_V1.commitmentsProof}?${query}`,
      { errorPrefix: 'commitment proof failed' }
    );
  }

  async adminCredit(request: AdminCreditRequestV1): Promise<AdminCreditResponseV1> {
    const headers: HeadersInit = {};
    if (this.sequencerAdminToken) {
      headers['x-sequencer-admin-token'] = this.sequencerAdminToken;
    }
    return postJson<AdminCreditResponseV1>(
      this.fetchImpl,
      `${this.sequencerUrl}${SEQUENCER_ROUTES_V1.adminCredit}`,
      request,
      { errorPrefix: 'admin credit failed', headers }
    );
  }
}

export type { CommitmentMetadataV1 };
