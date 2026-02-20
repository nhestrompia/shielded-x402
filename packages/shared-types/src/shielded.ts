import { isHex, isHex32 } from './hex.js';

export interface ShieldedPaymentValidationOptions {
  exactPublicInputsLength?: number;
  minPublicInputsLength?: number;
  maxProofHexLength?: number;
}

export function validateShieldedPaymentResponseShape(
  payload: unknown,
  options: ShieldedPaymentValidationOptions = {}
): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return 'invalid payment payload schema';
  }
  const cast = payload as Record<string, unknown>;
  const {
    exactPublicInputsLength,
    minPublicInputsLength = 1,
    maxProofHexLength
  } = options;

  if (!isHex(cast.proof)) return 'invalid proof encoding';
  if (maxProofHexLength !== undefined && cast.proof.length > maxProofHexLength) {
    return 'proof too large';
  }

  if (!Array.isArray(cast.publicInputs)) {
    return 'invalid public input length';
  }
  if (
    (exactPublicInputsLength !== undefined && cast.publicInputs.length !== exactPublicInputsLength) ||
    cast.publicInputs.length < minPublicInputsLength
  ) {
    return 'invalid public input length';
  }
  for (const input of cast.publicInputs) {
    if (!isHex(input)) {
      return 'invalid public input encoding';
    }
  }

  if (!isHex32(cast.nullifier)) return 'invalid nullifier';
  if (!isHex32(cast.root)) return 'invalid root';
  if (!isHex32(cast.merchantCommitment)) return 'invalid merchant commitment';
  if (!isHex32(cast.changeCommitment)) return 'invalid change commitment';
  if (!isHex32(cast.challengeHash)) return 'invalid challenge hash';
  if (!isHex(cast.encryptedReceipt)) return 'invalid encrypted receipt';
  return undefined;
}
