export type Hex = `0x${string}`;

function normalizeHex(value: string): Hex {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) {
    return (`0x${trimmed}` as Hex);
  }
  return trimmed as Hex;
}

export function parseHexBytes(value: string, label: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (!/^0x[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${label} must be a valid hex string`);
  }
  return Uint8Array.from(Buffer.from(normalized.slice(2), 'hex'));
}

export function parseSequencerPrivateKey(raw: string): Uint8Array {
  const bytes = parseHexBytes(raw, 'SEQUENCER_SIGNING_PRIVATE_KEY');
  if (bytes.length === 32) return bytes;
  if (bytes.length === 64) return bytes.slice(0, 32);
  throw new Error('SEQUENCER_SIGNING_PRIVATE_KEY must be 32-byte seed or 64-byte key');
}

export function parseSupportedChainRefs(raw: string | undefined): Set<string> {
  const fallback = ['eip155:8453', 'solana:devnet'];
  const source = raw ?? fallback.join(',');
  const refs = source
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (refs.length === 0) {
    throw new Error('SEQUENCER_SUPPORTED_CHAIN_REFS must include at least one chainRef');
  }
  return new Set(refs);
}

export function keyIdToBytes32(keyId: string): Hex {
  const bytes = Buffer.from(keyId, 'utf8');
  if (bytes.length > 32) {
    throw new Error('sequencer key id exceeds 32 bytes');
  }
  const padded = Buffer.alloc(32);
  bytes.copy(padded);
  return (`0x${padded.toString('hex')}` as Hex);
}

export function errorCodeFromMessage(message: string): string {
  if (message.includes('CONFLICT_EXECUTION')) return 'CONFLICT_EXECUTION';
  if (message.includes('UNAUTHORIZED_REPORTER')) return 'UNAUTHORIZED_REPORTER';
  if (message.includes('INVARIANT_VIOLATION')) return 'INVARIANT_VIOLATION';
  if (message.includes('unauthorized')) return 'UNAUTHORIZED';
  if (message.includes('not found')) return 'NOT_FOUND';
  return 'INVALID_REQUEST';
}
