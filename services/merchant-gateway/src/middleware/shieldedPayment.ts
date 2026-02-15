import type { Request, Response, NextFunction } from 'express';
import { ShieldedMerchantSDK } from '@shielded-x402/merchant';
import { X402_HEADERS } from '@shielded-x402/shared-types';
import type { VerifierAdapter } from '../lib/verifier.js';
import type { SettlementAdapter } from '../lib/settlement.js';

export interface ShieldedPaymentMiddlewareConfig {
  sdk: ShieldedMerchantSDK;
  verifier: VerifierAdapter;
  settlement: SettlementAdapter;
}

export function createShieldedPaymentMiddleware(config: ShieldedPaymentMiddlewareConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentSignature = req.header(X402_HEADERS.paymentSignature);
    const maxHeaderBytes = 256 * 1024;

    if (!paymentSignature) {
      const challenge = config.sdk.issue402();
      res.setHeader(X402_HEADERS.paymentRequired, challenge.headerValue);
      res.status(402).json({
        error: 'Payment Required',
        rail: challenge.requirement.rail,
        amount: challenge.requirement.amount,
        challengeNonce: challenge.requirement.challengeNonce,
        challengeExpiry: challenge.requirement.challengeExpiry
      });
      return;
    }

    if (Buffer.byteLength(paymentSignature, 'utf8') > maxHeaderBytes) {
      res.status(413).json({
        error: 'Invalid payment',
        reason: 'payment signature header too large'
      });
      return;
    }

    const verification = await config.sdk.verifyShieldedPayment(paymentSignature);

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

    if (!verification.payload) {
      res.status(402).json({
        error: 'Invalid payment',
        reason: 'missing verified payment payload'
      });
      return;
    }

    try {
      const settlement = await config.settlement.settleOnchain(verification.payload);
      if (settlement.alreadySettled) {
        res.status(409).json({
          error: 'Payment already settled',
          reason: 'nullifier already consumed onchain'
        });
        return;
      }
      await config.sdk.confirmSettlement(verification.payload.nullifier, settlement.txHash);
      if (settlement.txHash) {
        res.setHeader('x-shielded-settlement-tx', settlement.txHash);
      }
      res.setHeader('x-shielded-settlement', 'confirmed');
    } catch (error) {
      res.status(502).json({
        error: 'Payment settlement failed',
        reason: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    res.locals.shieldedPayment = verification;
    next();
  };
}
