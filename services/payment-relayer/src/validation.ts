import type { RelayPayRequestV1 } from '@shielded-x402/shared-types';
import { z } from 'zod';

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'value must be a non-empty string');

const strictHexSchema = nonEmptyStringSchema
  .refine((value) => /^0x[0-9a-fA-F]+$/i.test(value), 'value must be 0x-prefixed hex')
  .refine((value) => value.length % 2 === 0, 'hex value must have an even number of nibbles')
  .transform((value) => value.toLowerCase());

const hex32Schema = strictHexSchema.refine(
  (value) => /^0x[0-9a-f]{64}$/i.test(value),
  'value must be 32-byte hex'
);

const merchantRequestSchema = z
  .object({
    url: nonEmptyStringSchema,
    method: nonEmptyStringSchema.transform((value) => value.toUpperCase()),
    headers: z.record(z.string(), z.string()).optional(),
    bodyBase64: nonEmptyStringSchema.optional()
  })
  .strict();

const relayPayRequestSchema = z
  .object({
    authorization: z
      .object({
        version: z.literal(1),
        intentId: hex32Schema,
        authId: hex32Schema,
        authorizedAmountMicros: nonEmptyStringSchema,
        agentId: hex32Schema,
        agentNonce: nonEmptyStringSchema,
        merchantId: hex32Schema,
        chainRef: nonEmptyStringSchema,
        issuedAt: nonEmptyStringSchema,
        expiresAt: nonEmptyStringSchema,
        sequencerEpochHint: nonEmptyStringSchema,
        logSeqNo: nonEmptyStringSchema,
        sequencerKeyId: nonEmptyStringSchema
      })
      .strict(),
    sequencerSig: strictHexSchema,
    merchantRequest: merchantRequestSchema
  })
  .strict();

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return 'invalid relay payload';
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : 'payload';
  return `${path}: ${issue.message}`;
}

export function parseRelayPayRequest(payload: unknown): RelayPayRequestV1 {
  const parsed = relayPayRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error));
  }
  return parsed.data as RelayPayRequestV1;
}
