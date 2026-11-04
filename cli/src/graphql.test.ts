import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphqlClient } from '@jaegertracing/maintainer-tools-checks';
import { retryRequest } from '../../packages/checks/src/retry.js';

test('GraphQL retries a GOAWAY transport failure and returns the response', async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: unknown }) => {
    requests.push(init.body);
    if (requests.length === 1) {
      throw new Error('HTTP/2: "GOAWAY" frame received with code 0');
    }
    return new Response(JSON.stringify({ data: { viewer: { login: 'maintainer' } } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(await createGraphqlClient('test-token').fetchViewerLogin(), 'maintainer');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});

for (const status of [500, 502, 503, 504]) {
  test(`retries status ${status} with bounded backoff and preserves the final error`, async () => {
    const error = Object.assign(new Error('unavailable'), { status });
    let attempts = 0;
    const delays: number[] = [];
    await assert.rejects(
      retryRequest(
        async () => {
          attempts++;
          throw error;
        },
        async (delay) => {
          delays.push(delay);
        },
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });
}

for (const error of [
  ...[400, 401, 403, 404, 422, 429].map((status) =>
    Object.assign(new Error('rejected'), { status }),
  ),
  new Error('GraphQL validation failed'),
  Object.assign(new Error('aborted'), { name: 'AbortError', status: 500 }),
]) {
  test(`does not retry ${error.name}: ${'status' in error ? error.status : error.message}`, async () => {
    let attempts = 0;
    await assert.rejects(
      retryRequest(
        async () => {
          attempts++;
          throw error;
        },
        async () => {
          assert.fail('must not sleep');
        },
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, 1);
  });
}
