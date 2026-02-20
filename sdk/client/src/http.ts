export interface JsonRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: HeadersInit;
  allowNonOk?: boolean;
  errorPrefix?: string;
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: JsonRequestOptions = {}
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  };
  if (options.headers !== undefined) {
    init.headers = options.headers;
  }

  const response = await fetchImpl(url, init);

  if (!response.ok && !options.allowNonOk) {
    const text = await response.text();
    throw new Error(`${options.errorPrefix ?? 'request failed'}: ${response.status} ${text}`);
  }

  return (await response.json()) as T;
}

export async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  options: Omit<JsonRequestOptions, 'method' | 'body'> = {}
): Promise<T> {
  return requestJson<T>(fetchImpl, url, {
    ...options,
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    }
  });
}
