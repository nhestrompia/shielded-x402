export function normalizeRequestInput(input: string | URL): string {
  if (typeof input === 'string') return input;
  return input.toString();
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function headersInitToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return headersToRecord(new Headers(headers));
}
