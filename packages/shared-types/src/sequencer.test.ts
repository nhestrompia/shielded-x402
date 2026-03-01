import { describe, expect, it } from 'vitest';
import {
  X402_DOMAIN_TAGS,
  RELAYER_ROUTES_V1,
  SEQUENCER_ROUTES_V1,
  assertAgentAuthorizationInvariant,
  buildIntentTypedDataPayload,
  buildReclaimTypedDataPayload,
  canonicalExecutionReportBytes,
  buildMerkleProof,
  buildMerkleRoot,
  canonicalAuthorizationBytes,
  canonicalIntentBytes,
  canonicalReclaimRequestBytes,
  computeAuthorizationLeaf,
  deriveAgentIdFromPubKey,
  deriveAuthorizationId,
  deriveLeafSalt,
  deriveMerchantId,
  hashAuthorization,
  hashExecutionReport,
  hashIntent,
  normalizeMerchantEndpointUrl,
  verifyMerkleProof,
  type AuthorizationV1,
  type IntentV1
} from './sequencer.js';

describe('sequencer protocol tags', () => {
  it('locks canonical domain tags', () => {
    expect(X402_DOMAIN_TAGS.intentV1).toBe('x402:intent:v1');
    expect(X402_DOMAIN_TAGS.authorizationV1).toBe('x402:authorization:v1');
    expect(X402_DOMAIN_TAGS.authLeafV1).toBe('x402:authleaf:v1');
    expect(X402_DOMAIN_TAGS.executionReportV1).toBe('x402:execution-report:v1');
  });
});

describe('protocol routes', () => {
  it('locks route paths', () => {
    expect(SEQUENCER_ROUTES_V1.authorize).toBe('/v1/credit/authorize');
    expect(SEQUENCER_ROUTES_V1.executions).toBe('/v1/credit/executions');
    expect(SEQUENCER_ROUTES_V1.reclaim).toBe('/v1/credit/reclaim');
    expect(RELAYER_ROUTES_V1.pay).toBe('/v1/relay/pay');
  });
});

describe('merchant id normalization', () => {
  it('normalizes URL deterministically', () => {
    expect(normalizeMerchantEndpointUrl('https://EXAMPLE.com:443/pay/')).toBe(
      'https://example.com/pay'
    );
    expect(normalizeMerchantEndpointUrl('https://example.com/')).toBe(
      'https://example.com/'
    );
  });

  it('derives stable merchant id', () => {
    const a = deriveMerchantId({
      serviceRegistryId: 'reg-1',
      endpointUrl: 'https://EXAMPLE.com:443/pay?a=1'
    });
    const b = deriveMerchantId({
      serviceRegistryId: 'reg-1',
      endpointUrl: 'https://example.com/pay'
    });
    expect(a).toBe(b);
  });
});

describe('intent and authorization canonicalization', () => {
  it('produces deterministic intent/auth hashes', () => {
    const intent: IntentV1 = {
      version: 1,
      agentId: deriveAgentIdFromPubKey(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ),
      agentPubKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signatureScheme: 'ed25519-sha256-v1',
      agentNonce: '1',
      amountMicros: '1000',
      merchantId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      requiredChainRef: 'solana:devnet',
      expiresAt: '1735689600',
      requestId: '0x1111111111111111111111111111111111111111111111111111111111111111'
    };
    const intentHash = hashIntent(intent);
    const authId = deriveAuthorizationId({
      intentId: intentHash,
      sequencerEpoch: '1',
      seqNo: '7'
    });
    const auth: AuthorizationV1 = {
      version: 1,
      intentId: intentHash,
      authId,
      authorizedAmountMicros: intent.amountMicros,
      agentId: intent.agentId,
      agentNonce: intent.agentNonce,
      merchantId: intent.merchantId,
      chainRef: intent.requiredChainRef,
      issuedAt: '1735689000',
      expiresAt: intent.expiresAt,
      sequencerEpochHint: '1',
      logSeqNo: '7',
      sequencerKeyId: 'seq-key-1'
    };
    expect(canonicalIntentBytes(intent)).toEqual(canonicalIntentBytes(intent));
    expect(canonicalAuthorizationBytes(auth)).toEqual(canonicalAuthorizationBytes(auth));
    expect(hashAuthorization(auth)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('builds typed data payload with zeroed optionals', () => {
    const intent: IntentV1 = {
      version: 1,
      agentId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agentPubKey: '0x1234',
      signatureScheme: 'eip712-secp256k1',
      agentNonce: '2',
      amountMicros: '5',
      merchantId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      requiredChainRef: 'eip155:8453',
      expiresAt: '1735689600',
      requestId: '0x1111111111111111111111111111111111111111111111111111111111111111'
    };
    const payload = buildIntentTypedDataPayload(intent);
    expect(payload.primaryType).toBe('IntentV1');
    expect(payload.message.serviceHash).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('canonicalizes execution reports and reclaim payloads', () => {
    const reportPayload = {
      authId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chainRef: 'solana:devnet',
      executionTxHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      status: 'SUCCESS' as const,
      reportId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      reportedAt: '1735689601',
      relayerKeyId: 'sol-relayer-1'
    };
    expect(canonicalExecutionReportBytes(reportPayload)).toEqual(
      canonicalExecutionReportBytes(reportPayload)
    );
    expect(hashExecutionReport(reportPayload)).toMatch(/^0x[0-9a-f]{64}$/);

    const reclaimPayload = {
      authId: reportPayload.authId,
      callerType: 'agent' as const,
      agentId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      requestedAt: '1735689602'
    };
    expect(canonicalReclaimRequestBytes(reclaimPayload)).toEqual(
      canonicalReclaimRequestBytes(reclaimPayload)
    );

    const reclaimTyped = buildReclaimTypedDataPayload(reclaimPayload);
    expect(reclaimTyped.primaryType).toBe('ReclaimV1');
    expect(reclaimTyped.message.callerType).toBe(1);
    expect(reclaimTyped.message.agentId).toBe(reclaimPayload.agentId);
  });
});

describe('leaf and merkle proofs', () => {
  it('verifies inclusion proofs', () => {
    const authHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const leaf0 = computeAuthorizationLeaf({
      logSeqNo: '1',
      prevLeafHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      authHash,
      salt: deriveLeafSalt(
        '0x9999999999999999999999999999999999999999999999999999999999999999',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    });
    const leaf1 = computeAuthorizationLeaf({
      logSeqNo: '2',
      prevLeafHash: leaf0,
      authHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      salt: deriveLeafSalt(
        '0x9999999999999999999999999999999999999999999999999999999999999999',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      )
    });
    const leaves = [leaf0, leaf1] as const;
    const root = buildMerkleRoot(leaves);
    const proof = buildMerkleProof(leaves, 1);
    expect(
      verifyMerkleProof({
        leafHash: leaf1,
        leafIndex: 1,
        proof,
        expectedRoot: root
      })
    ).toBe(true);
  });
});

describe('agent invariant', () => {
  it('accepts strict nonce sequence within credited cap', () => {
    expect(() =>
      assertAgentAuthorizationInvariant({
        creditedMicros: '100',
        acceptedAuthorizations: [
          { agentNonce: '0', amountMicros: '30' },
          { agentNonce: '1', amountMicros: '40' },
          { agentNonce: '2', amountMicros: '30' }
        ]
      })
    ).not.toThrow();
  });

  it('rejects nonce gaps and overspend', () => {
    expect(() =>
      assertAgentAuthorizationInvariant({
        creditedMicros: '100',
        acceptedAuthorizations: [
          { agentNonce: '0', amountMicros: '30' },
          { agentNonce: '2', amountMicros: '40' }
        ]
      })
    ).toThrow();

    expect(() =>
      assertAgentAuthorizationInvariant({
        creditedMicros: '50',
        acceptedAuthorizations: [
          { agentNonce: '0', amountMicros: '30' },
          { agentNonce: '1', amountMicros: '30' }
        ]
      })
    ).toThrow();
  });
});
