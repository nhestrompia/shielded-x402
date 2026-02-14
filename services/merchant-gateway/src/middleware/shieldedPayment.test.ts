import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { X402_HEADERS } from '@shielded-x402/shared-types';
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

describe('shieldedPayment middleware', () => {
  it('returns 402 with challenge when payment headers missing', async () => {
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeSDK(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      }
    });

    const req = {
      header: () => null
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => undefined) as NextFunction;

    await middleware(req, res, next);

    expect(state.statusCode).toBe(402);
    expect(state.headers[X402_HEADERS.paymentRequirement]).toBeTruthy();
  });

  it('rejects oversized payment response payload', async () => {
    const middleware = createShieldedPaymentMiddleware({
      sdk: makeSDK(),
      verifier: {
        verifyProof: async () => true,
        isNullifierUsed: async () => false
      }
    });

    const huge = 'x'.repeat(300 * 1024);
    const req = {
      header: (name: string) => {
        if (name === X402_HEADERS.paymentResponse) return huge;
        if (name === X402_HEADERS.paymentSignature) return '0x1234';
        if (name === X402_HEADERS.challengeNonce) return '0x01';
        return null;
      }
    } as unknown as Request;

    const { res, state } = makeRes();
    const next = (() => undefined) as NextFunction;

    await middleware(req, res, next);
    expect(state.statusCode).toBe(413);
  });
});
