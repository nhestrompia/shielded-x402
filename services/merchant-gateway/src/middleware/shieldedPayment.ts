import type { Request, Response, NextFunction } from 'express';
import { ShieldedMerchantSDK } from '@shielded-x402/merchant';
import { X402_HEADERS } from '@shielded-x402/shared-types';
import type { VerifierAdapter } from '../lib/verifier.js';

export interface ShieldedPaymentMiddlewareConfig {
  sdk: ShieldedMerchantSDK;
  verifier: VerifierAdapter;
}

export function createShieldedPaymentMiddleware(config: ShieldedPaymentMiddlewareConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentResponse = req.header(X402_HEADERS.paymentResponse);
    const paymentSignature = req.header(X402_HEADERS.paymentSignature);
    const challengeNonce = req.header(X402_HEADERS.challengeNonce);
    const maxHeaderBytes = 256 * 1024;

    if (!paymentResponse || !paymentSignature || !challengeNonce) {
      const challenge = config.sdk.issue402();
      res.setHeader(X402_HEADERS.paymentRequirement, challenge.headerValue);
      res.status(402).json({
        error: 'Payment Required',
        rail: challenge.requirement.rail,
        amount: challenge.requirement.amount,
        challengeNonce: challenge.requirement.challengeNonce,
        challengeExpiry: challenge.requirement.challengeExpiry
      });
      return;
    }

    if (Buffer.byteLength(paymentResponse, 'utf8') > maxHeaderBytes) {
      res.status(413).json({
        error: 'Invalid payment',
        reason: 'payment response too large'
      });
      return;
    }

    const verification = await config.sdk.verifyShieldedPayment(
      paymentResponse,
      paymentSignature,
      { challengeNonce }
    );

    if (!verification.ok) {
      res.status(402).json({
        error: 'Invalid payment',
        reason: verification.reason
      });
      return;
    }

    if (verification.payload?.nullifier) {
      await config.verifier.markNullifierUsed?.(verification.payload.nullifier);
    }

    res.locals.shieldedPayment = verification;
    next();
  };
}
