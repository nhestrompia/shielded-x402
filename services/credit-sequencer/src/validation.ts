import type {
  AuthorizeRequestV1,
  ExecutionReportV1,
  IntentV1,
  ReclaimRequestV1
} from '@shielded-x402/shared-types';
import type { Hex } from '@shielded-x402/shared-types';
import { z } from 'zod';

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'value must be a non-empty string');

const strictHexSchema = nonEmptyStringSchema
  .refine((value) => /^0x[0-9a-fA-F]+$/i.test(value), 'value must be 0x-prefixed hex')
  .refine((value) => value.length % 2 === 0, 'hex value must have an even number of nibbles')
  .transform((value) => value.toLowerCase() as Hex);

const hex32Schema = strictHexSchema.refine(
  (value) => /^0x[0-9a-f]{64}$/i.test(value),
  'value must be 32-byte hex'
);

const uint64StringSchema = nonEmptyStringSchema.refine((value) => {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= UINT64_MAX;
  } catch {
    return false;
  }
}, 'value must be uint64');

const signatureSchemeSchema = z.enum(['eip712-secp256k1', 'ed25519-sha256-v1']);
const executionStatusSchema = z.enum(['SUCCESS', 'FAILED']);
const reclaimCallerSchema = z.enum(['agent', 'sequencer']);

const intentSchema = z
  .object({
    version: z.literal(1),
    agentId: hex32Schema,
    agentPubKey: strictHexSchema,
    signatureScheme: signatureSchemeSchema,
    agentNonce: uint64StringSchema,
    amountMicros: uint64StringSchema,
    merchantId: hex32Schema,
    requiredChainRef: nonEmptyStringSchema,
    expiresAt: uint64StringSchema,
    requestId: hex32Schema,
    serviceHash: hex32Schema.optional(),
    memoHash: hex32Schema.optional()
  })
  .strict();

const authorizeRequestSchema = z
  .object({
    intent: intentSchema,
    agentSig: strictHexSchema
  })
  .strict();

const executionReportSchema = z
  .object({
    authId: hex32Schema,
    chainRef: nonEmptyStringSchema,
    executionTxHash: nonEmptyStringSchema,
    status: executionStatusSchema,
    reportId: hex32Schema,
    reportedAt: uint64StringSchema,
    relayerKeyId: nonEmptyStringSchema,
    reportSig: strictHexSchema
  })
  .strict();

const reclaimRequestSchema = z
  .object({
    authId: hex32Schema,
    callerType: reclaimCallerSchema,
    requestedAt: uint64StringSchema,
    agentId: hex32Schema.optional(),
    agentSig: strictHexSchema.optional()
  })
  .strict();

const adminCreditRequestSchema = z
  .object({
    agentId: hex32Schema,
    amountMicros: uint64StringSchema
  })
  .strict()
  .refine((value) => BigInt(value.amountMicros) > 0n, {
    message: 'amountMicros must be > 0',
    path: ['amountMicros']
  });

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return 'invalid request payload';
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : 'payload';
  return `${path}: ${issue.message}`;
}

export function parseUint64(value: string, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`invalid uint64 for ${label}`);
  }
  if (parsed < 0n || parsed > UINT64_MAX) {
    throw new Error(`uint64 out of range for ${label}`);
  }
  return parsed;
}

export function normalizeExecutionTxHash(value: string): string {
  const trimmed = value.trim();
  if (/^0x/i.test(trimmed)) {
    const parsed = strictHexSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw new Error('executionTxHash must be 0x-prefixed hex when using hex format');
    }
    return parsed.data;
  }
  if (trimmed.length === 0) {
    throw new Error('executionTxHash must be a non-empty string');
  }
  return trimmed;
}

export function parseAuthorizeRequest(payload: unknown): AuthorizeRequestV1 {
  const parsed = authorizeRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  const { intent, agentSig } = parsed.data;
  return {
    intent: intent as IntentV1,
    agentSig
  };
}

export function parseExecutionReport(payload: unknown): ExecutionReportV1 {
  const parsed = executionReportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  const report = parsed.data;
  return {
    ...report,
    executionTxHash: normalizeExecutionTxHash(report.executionTxHash)
  };
}

export function parseReclaimRequest(payload: unknown): ReclaimRequestV1 {
  const parsed = reclaimRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  return parsed.data as ReclaimRequestV1;
}

export function parseAdminCreditRequest(payload: unknown): { agentId: Hex; amountMicros: bigint } {
  const parsed = adminCreditRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  return {
    agentId: parsed.data.agentId,
    amountMicros: BigInt(parsed.data.amountMicros)
  };
}
