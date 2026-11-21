import { setTimeout } from 'node:timers/promises';

const MAX_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

function headerValue(error: unknown, name: string): string | undefined {
  const candidate = error as {
    headers?: Headers | Record<string, string | number | undefined>;
    response?: { headers?: Headers | Record<string, string | number | undefined> };
  } | null;
  const headers = candidate?.response?.headers ?? candidate?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | number | undefined>;
  const key = Object.keys(record).find((entry) => entry.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : record[key];
  return value === undefined ? undefined : String(value);
}

function isRateLimitError(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    message?: string;
    errors?: Array<{ type?: string; message?: string }>;
  } | null;
  const status = candidate?.status;
  if (status === 429 || (status === 403 && headerValue(error, 'x-ratelimit-remaining') === '0')) {
    return true;
  }
  if (headerValue(error, 'retry-after') !== undefined) {
    return true;
  }
  return (
    candidate?.errors?.some(
      (entry) =>
        entry.type?.toUpperCase() === 'RATE_LIMITED' ||
        entry.message?.toLowerCase().includes('rate limit') === true,
    ) ?? candidate?.message?.toLowerCase().includes('rate limit') === true
  );
}

function rateLimitWaitMs(error: unknown, attempt: number): number {
  const retryAfter = headerValue(error, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, seconds * 1000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, retryAt - Date.now()));
    }
  }

  const reset = Number(headerValue(error, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1000, reset * 1000 - Date.now()));
  }

  return Math.min(MAX_RATE_LIMIT_WAIT_MS, 1000 * 2 ** attempt);
}

export async function retryRequest<T>(
  request: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      // Octokit reports transport failures, including HTTP/2 GOAWAY, with status 500.
      const status = (error as { status?: number } | null)?.status;
      const retryableTransport = [500, 502, 503, 504].includes(status ?? 0);
      if ((error instanceof Error && error.name === 'AbortError') || attempt >= MAX_RETRIES) {
        throw error;
      }
      if (!retryableTransport && !isRateLimitError(error)) {
        throw error;
      }
      await sleep(isRateLimitError(error) ? rateLimitWaitMs(error, attempt) : 1000 * 2 ** attempt);
    }
  }
}
