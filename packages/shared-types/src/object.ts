export function getRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

export function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function getIntegerString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed)) && Number(trimmed) >= 0) {
      return Math.trunc(Number(trimmed)).toString();
    }
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString();
  }
  return undefined;
}

export function getStringFromRecords(
  key: string,
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = getString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function getIntegerStringFromRecords(
  key: string,
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = getIntegerString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
