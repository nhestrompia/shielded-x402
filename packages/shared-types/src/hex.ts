import type { Hex } from './types.js';

export function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

export function isHex32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function normalizeHex(value: string): Hex {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('0x')) {
    return (trimmed as Hex);
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return (`0x${BigInt(trimmed).toString(16)}` as Hex);
  }
  return (`0x${trimmed}` as Hex);
}
