import { setTimeout } from 'node:timers/promises';

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
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        attempt >= 2 ||
        ![500, 502, 503, 504].includes(status ?? 0)
      ) {
        throw error;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}
