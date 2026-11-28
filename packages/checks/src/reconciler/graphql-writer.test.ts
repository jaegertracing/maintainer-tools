import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createChangeWriter } from './graphql-writer.js';

const PR = { repo: { owner: 'example', name: 'repo' }, number: 7 };

// Replaces `fetch` with a GitHub that knows one pull request and one label.
// It returns the operations that it received, as the name of each with its
// variables.
function mockGitHub(t: TestContext, state = 'OPEN'): string[] {
  const operations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const name = /(?:query|mutation) (\w+)/.exec(query)![1]!;
    operations.push(`${name} ${JSON.stringify(variables)}`);
    const data =
      name === 'PullRequestNode'
        ? { repository: { pullRequest: { id: 'PR_7', state } } }
        : name === 'LabelId'
          ? { repository: { label: variables.label === 'stale' ? { id: 'LA_stale' } : null } }
          : {};
    return new Response(JSON.stringify({ data }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return operations;
}

test('the writer sends each change as one mutation and asks for a node ID once', async (t) => {
  const operations = mockGitHub(t);
  const writer = createChangeWriter('test-token');
  assert.equal(await writer.isOpen(PR), true);
  await writer.addLabel(PR, 'stale');
  await writer.removeLabel(PR, 'stale');
  await writer.createComment(PR, 'A notice.');
  await writer.editComment('IC_1', 'An edited notice.');
  await writer.minimizeComment('IC_1');
  await writer.close(PR);

  assert.deepEqual(operations, [
    'PullRequestNode {"owner":"example","name":"repo","number":7}',
    'LabelId {"owner":"example","name":"repo","label":"stale"}',
    'AddLabel {"pullRequestId":"PR_7","labelId":"LA_stale"}',
    'RemoveLabel {"pullRequestId":"PR_7","labelId":"LA_stale"}',
    'CreateComment {"pullRequestId":"PR_7","body":"A notice."}',
    'EditComment {"commentId":"IC_1","body":"An edited notice."}',
    'MinimizeComment {"commentId":"IC_1"}',
    'Close {"pullRequestId":"PR_7"}',
  ]);
});

test('the writer refuses a label that the repository does not have', async (t) => {
  const operations = mockGitHub(t);
  const writer = createChangeWriter('test-token');
  await assert.rejects(
    writer.addLabel(PR, 'duplicate'),
    /the label duplicate of example\/repo does not exist/,
  );
  assert.equal(
    operations.some((operation) => operation.startsWith('AddLabel')),
    false,
  );
});

test('the writer sends a mutation once when GitHub fails', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('unavailable', { status: 502 });
  });
  await assert.rejects(createChangeWriter('test-token').minimizeComment('IC_1'));
  assert.equal(requests, 1);
});

test('the writer reports a merged pull request as not open', async (t) => {
  mockGitHub(t, 'MERGED');
  assert.equal(await createChangeWriter('test-token').isOpen(PR), false);
});
