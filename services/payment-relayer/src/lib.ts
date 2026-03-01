import type { Hex } from '@shielded-x402/shared-types';
import { createHash } from 'node:crypto';
import net from 'node:net';

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

function sha256Hex(input: Buffer): Hex {
  return (`0x${sha256(input).toString('hex')}` as Hex);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map((segment) => Number(segment));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    );
  }
  return true;
}

export function deriveExecutionTxHash(input: {
  authId: Hex;
  chainRef: string;
  payoutMode: 'forward' | 'noop' | 'solana' | 'evm';
  merchantResult: { status: number; bodyBase64: string };
}): string {
  if (input.payoutMode === 'solana') {
    const parsed = JSON.parse(
      Buffer.from(input.merchantResult.bodyBase64, 'base64').toString('utf8')
    ) as { txSignature?: string };
    if (typeof parsed.txSignature !== 'string' || parsed.txSignature.length === 0) {
      throw new Error('solana adapter missing txSignature');
    }
    return parsed.txSignature;
  }
  if (input.payoutMode === 'evm') {
    const parsed = JSON.parse(
      Buffer.from(input.merchantResult.bodyBase64, 'base64').toString('utf8')
    ) as { txHash?: string };
    if (typeof parsed.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parsed.txHash)) {
      throw new Error('evm adapter missing txHash');
    }
    return parsed.txHash;
  }
  if (input.payoutMode === 'noop') {
    return sha256Hex(Buffer.from(`${input.authId}|${input.chainRef}|noop`, 'utf8'));
  }
  const bodyHash = sha256Hex(Buffer.from(input.merchantResult.bodyBase64, 'base64'));
  return sha256Hex(
    Buffer.from(
      `${input.authId}|${input.chainRef}|forward|${input.merchantResult.status}|${bodyHash}`,
      'utf8'
    )
  );
}

export function isRelayCallerAuthorized(
  expectedToken: string | undefined,
  providedToken: string | undefined
): boolean {
  if (!expectedToken) return true;
  if (!providedToken) return false;
  return providedToken === expectedToken;
}
