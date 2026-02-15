import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { X402_HEADERS, type ShieldedPaymentResponse } from '@shielded-x402/shared-types';
import { createShieldedPaymentMiddleware } from './shieldedPayment.js';
import { ShieldedMerchantSDK } from '@shielded-x402/merchant';

function makeSDK(): ShieldedMerchantSDK {
  return new ShieldedMerchantSDK(
    {
      rail: 'shielded-usdc',
      price: 1n,
      merchantPubKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      verifyingContract: '0x2222222222222222222222222222222222222222',
      challengeTtlMs: 1000,
      now: () => 1000
    },
    {
      verifyProof: async () => true,
      isNullifierUsed: async () => false
    }
  );
}

function makeRes() {
  const state: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = {
    headers: {}
  };

  const res = {
    setHeader: (name: string, value: string) => {
      state.headers[name.toLowerCase()] = value;
    },
    status: (code: number) => {
      state.statusCode = code;
      return res;
    },
    json: (value: unknown) => {
      state.body = value;
      return res;
    },
    locals: {}
  } as unknown as Response;

  return { res, state };
}

const validPayload: ShieldedPaymentResponse = {
  proof: '0x01',
  publicInputs: [
    '0x1111111111111111111111111111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333333333333333333333333333',
    '0x4444444444444444444444444444444444444444444444444444444444444444',
    '0x5555555555555555555555555555555555555555555555555555555555555555',
    '0x0000000000000000000000000000000000000000000000000000000000000028'
  ],
  nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
  root: '0x2222222222222222222222222222222222222222222222222222222222222222',
  merchantCommitment: '0x3333333333333333333333333333333333333333333333333333333333333333',
  changeCommitment: '0x4444444444444444444444444444444444444444444444444444444444444444',
  challengeHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
  encryptedReceipt: '0x'
};

function makeVerifiedSdk(): ShieldedMerchantSDK {
  return {
    issue402: () => {
      return {
        requirement: {
          scheme: 'exact',
          network: 'eip155:11155111',
          asset: '0x0000000000000000000000000000000000000000000000000000000000000000',
          payTo: '0x2222222222222222222222222222222222222222',
          rail: 'shielded-usdc',
          amount: '1',
          challengeNonce:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          challengeExpiry: '1000',
          merchantPubKey:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
          verifyingContract: '0x2222222222222222222222222222222222222222'
        },
        headerValue: 'header'
      };
    },
    verifyShieldedPayment: async () => ({ ok: true, payload: validPayload }),
    confirmSettlement: async () => true
  } as unknown as ShieldedMerchantSDK;
}

describe('shieldedPayment middleware', () => {
  it('returns 402 with challenge when payment headers missing', async () => {
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeSDK(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      }
    });

    const req = {
      header: () => null
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => undefined) as NextFunction;

    await middleware(req, res, next);

    expect(state.statusCode).toBe(402);
    expect(state.headers[X402_HEADERS.paymentRequired.toLowerCase()]).toBeTruthy();
  });

  it('rejects oversized payment signature payload', async () => {
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeSDK(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false })
      }
    });

    const huge = 'x'.repeat(300 * 1024);
    const req = {
      header: (name: string) => {
        if (name === X402_HEADERS.paymentSignature) return huge;
        return null;
      }
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => undefined) as NextFunction;

    await middleware(req, res, next);
    expect(state.statusCode).toBe(413);
  });

  it('returns 502 when onchain settlement fails', async () => {
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeVerifiedSdk(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => {
          throw new Error('tx reverted');
        }
      }
    });

    const req = {
      header: (name: string) => {
        if (name === X402_HEADERS.paymentSignature) return '0x1234';
        return null;
      }
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => undefined) as NextFunction;

    await middleware(req, res, next);
    expect(state.statusCode).toBe(502);
  });

  it('calls next on verified and settled payment', async () => {
    let nextCalled = false;
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeVerifiedSdk(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      },
      settlement: {
        settleOnchain: async () => ({ alreadySettled: false, txHash: '0x1234' })
      }
    });

    const req = {
      header: (name: string) => {
        if (name === X402_HEADERS.paymentSignature) return '0x1234';
        return null;
      }
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => {
      nextCalled = true;
    }) as NextFunction;

    await middleware(req, res, next);
    expect(state.statusCode).toBeUndefined();
    expect(nextCalled).toBe(true);
    expect(state.headers['x-shielded-settlement']).toBe('confirmed');
    expect(state.headers['x-shielded-settlement-tx']).toBe('0x1234');
  });
});
