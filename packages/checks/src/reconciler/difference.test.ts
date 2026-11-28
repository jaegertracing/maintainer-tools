import assert from 'node:assert/strict';
import test from 'node:test';

import { LIFECYCLE_COMMENT_MARKER } from '../policy-comments.js';
import { ruleSet } from '../policy.js';
import { DEFAULT_POLICY_AGES } from '../types.js';
import type { OpenPullRequests, PolicyAges, PullRequest } from '../types.js';
import { changesOf } from './difference.js';
import type { Change } from './difference.js';
import { planOf, RESOLVED_COMMENT_BODY } from './plan.js';
import type { Plan } from './plan.js';
import { carrying, daysAgo, NOW, pullRequest, unapprovedIssue } from './pull-request-fixture.js';

type Comment = PullRequest['comments'][number];

function reconcilerComment(id: string, days: number, body: string): Comment {
  return {
    id,
    author: 'github-actions',
    authorIsBot: true,
    createdAt: daysAgo(days),
    body,
    isMinimized: false,
  };
}

function plan(
  pr: PullRequest,
  others: PullRequest[] = [],
  ages: PolicyAges = DEFAULT_POLICY_AGES,
): Plan {
  const openPullRequests: OpenPullRequests = {
    pullRequests: [pr, ...others],
    quotaExemptLogins: new Set(),
    collaborators: { 'example/repo': { maintainer: 'ADMIN' } },
  };
  return planOf(pr, ruleSet.evaluate(pr, { now: NOW, openPullRequests, ages }), ages);
}

function print(change: Change): string {
  if (change.kind === 'add label' || change.kind === 'remove label') {
    return `${change.kind} ${change.label}`;
  }
  if (change.kind === 'edit comment' || change.kind === 'minimize comment') {
    return `${change.kind} ${change.id}`;
  }
  return change.kind;
}

// The changes of a pull request, with the text of a comment left out.
function changes(pr: PullRequest, others: PullRequest[] = []): string[] {
  return changesOf(pr, plan(pr, others)).map(print);
}

const withoutIssue = { linkedIssues: [], body: '' };
const EARLIER_NOTICE = `${LIFECYCLE_COMMENT_MARKER}\nAn earlier notice.`;

test('a pull request that meets every policy has no change', () => {
  assert.deepEqual(changes(pullRequest()), []);
});

test('a pull request without an issue gets its labels and a new comment', () => {
  const pr = pullRequest(withoutIssue);
  assert.deepEqual(changes(pr), [
    'add label missing-issue',
    'add label waiting-for-author',
    'create comment',
  ]);
  assert.equal(
    plan(pr).comment,
    [
      LIFECYCLE_COMMENT_MARKER,
      '@contributor, this pull request needs attention.',
      '',
      '- This pull request must link an open issue that is labelled `help wanted`: no issue is linked. See the [linked issue policy](https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#link-each-pull-request-to-an-issue).',
      '',
      'This pull request is closed 7 days after it was flagged, unless it links an approved issue before that.',
    ].join('\n'),
  );
});

test('an issue that no maintainer approved gets the other flag label', () => {
  const pr = pullRequest({ linkedIssues: [unapprovedIssue] });
  assert.deepEqual(changes(pr).slice(0, 1), ['add label unapproved-issue']);
  assert.match(plan(pr).comment!, /#101 is not labelled `help wanted`/);
});

test('a flag label is swapped by adding before removing, without a new comment', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(3, 'unapproved-issue', 'waiting-for-author'),
  });
  const told = { ...pr, comments: [reconcilerComment('c1', 3, plan(pr).comment!)] };
  assert.deepEqual(changes(told), ['add label missing-issue', 'remove label unapproved-issue']);
});

test('a label of the reconciler that a person applied by hand is removed', () => {
  assert.deepEqual(changes(pullRequest(carrying(3, 'duplicate'))), ['remove label duplicate']);
});

test('a comment whose text changed is edited when the author knows every reason', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(3, 'missing-issue', 'waiting-for-author'),
  });
  const told = { ...pr, comments: [reconcilerComment('c1', 3, EARLIER_NOTICE)] };
  assert.deepEqual(changes(told), ['edit comment c1']);
});

test('a notice that a replaced action posted a second before its label is edited once', () => {
  const labelledAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
  const pr = pullRequest({
    ...withoutIssue,
    labels: ['missing-issue', 'waiting-for-author'],
    labelEvents: [
      { label: 'missing-issue', event: 'labeled', at: labelledAt.toISOString() },
      { label: 'waiting-for-author', event: 'labeled', at: labelledAt.toISOString() },
    ],
  });
  const noticeOfReplacedAction: Comment = {
    ...reconcilerComment('c1', 3, '<!-- jaeger-pr-linked-issue -->\nThis PR links no issue.'),
    createdAt: new Date(labelledAt.getTime() - 1000).toISOString(),
  };
  assert.deepEqual(changes({ ...pr, comments: [noticeOfReplacedAction] }), ['edit comment c1']);
  const edited = { ...noticeOfReplacedAction, body: plan(pr).comment! };
  assert.deepEqual(changes({ ...pr, comments: [edited] }), []);
});

test('a label that was applied after the earlier notice gets a new comment', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(3, 'missing-issue', 'waiting-for-author'),
  });
  const toldEarlier = {
    ...pr,
    comments: [reconcilerComment('c1', 5, `${LIFECYCLE_COMMENT_MARKER}\nAn earlier notice.`)],
  };
  assert.deepEqual(changes(toldEarlier), ['create comment', 'minimize comment c1']);
});

test('a label that no event dates gets no second comment with the same text', () => {
  const pr = pullRequest({ ...quiet, labels: ['stale'] });
  assert.deepEqual(changes(pr), ['create comment']);
  const told = { ...pr, comments: [reconcilerComment('c1', 1, plan(pr).comment!)] };
  assert.deepEqual(changes(told), []);
});

test('a label that was removed and applied again gets a new comment with the same text', () => {
  const pr = pullRequest({
    ...withoutIssue,
    labels: ['missing-issue', 'waiting-for-author'],
    labelEvents: [
      { label: 'missing-issue', event: 'labeled', at: daysAgo(9) },
      { label: 'missing-issue', event: 'unlabeled', at: daysAgo(5) },
      { label: 'missing-issue', event: 'labeled', at: daysAgo(1) },
    ],
  });
  const toldInTheFirstPeriod = {
    ...pr,
    comments: [reconcilerComment('c1', 9, plan(pr).comment!)],
  };
  assert.deepEqual(changes(toldInTheFirstPeriod), ['create comment', 'minimize comment c1']);
});

test('a minimized comment still records what the author was told', () => {
  const minimizedNotice = { ...reconcilerComment('c1', 3, EARLIER_NOTICE), isMinimized: true };
  const resolved = pullRequest({ comments: [minimizedNotice] });
  assert.deepEqual(changes(resolved), ['create comment']);

  const expired = pullRequest({
    ...withoutIssue,
    ...carrying(8, 'missing-issue', 'waiting-for-author'),
  });
  const minimizedClosing = {
    ...reconcilerComment('c2', 0, plan(expired).comment!),
    isMinimized: true,
  };
  assert.deepEqual(changes({ ...expired, comments: [minimizedClosing] }), ['close']);
});

test('a notice that a maintainer posted is left as the notice', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(3, 'missing-issue', 'waiting-for-author'),
  });
  const toldByMaintainer = {
    ...pr,
    comments: [
      {
        id: 'c1',
        author: 'maintainer',
        authorIsBot: false,
        createdAt: daysAgo(3),
        body: '<!-- jaeger-pr-linked-issue -->\nThis PR links no approved issue.',
        isMinimized: false,
      },
    ],
  };
  assert.deepEqual(changes(toldByMaintainer), []);
});

test('a pull request whose notice period has passed is closed with a new comment', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(8, 'missing-issue', 'waiting-for-author'),
  });
  const told = { ...pr, comments: [reconcilerComment('c1', 8, EARLIER_NOTICE)] };
  assert.deepEqual(changes(told), ['create comment', 'minimize comment c1', 'close']);
  // The comment that closes says so first and repeats no warning.
  assert.equal(
    plan(told).comment,
    [
      LIFECYCLE_COMMENT_MARKER,
      '@contributor, this pull request is closed, because its notice period has passed and the following still holds.',
      '',
      '- This pull request must link an open issue that is labelled `help wanted`: no issue is linked. See the [linked issue policy](https://github.com/jaegertracing/jaeger/blob/main/CONTRIBUTING_GUIDELINES.md#link-each-pull-request-to-an-issue).',
      '',
      'It can be reopened once that has changed.',
    ].join('\n'),
  );
});

test('the ages of the config set the notice period and the deadline of the comment', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(8, 'missing-issue', 'waiting-for-author'),
  });
  const longerNotice = plan(pr, [], { ...DEFAULT_POLICY_AGES, flagNoticeDays: 10 });
  assert.equal(longerNotice.shouldClose, false);
  assert.match(longerNotice.comment!, /This pull request is closed 10 days after it was flagged/);
  assert.equal(plan(pr, [], { ...DEFAULT_POLICY_AGES, flagNoticeDays: 8 }).shouldClose, true);
});

test('a run that stopped between the comment and the closing only closes', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(8, 'missing-issue', 'waiting-for-author'),
  });
  const told = { ...pr, comments: [reconcilerComment('c1', 0, plan(pr).comment!)] };
  assert.deepEqual(changes(told), ['close']);
});

test('a closing comment counts as posted when a reason went away after it', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(8, 'missing-issue', 'duplicate', 'waiting-for-author'),
  });
  const closingCommentWithDuplicate = plan(pr).comment!.replace(
    '\n\nIt can be reopened',
    '\n- Another pull request closes the same issue.\n\nIt can be reopened',
  );
  const told = { ...pr, comments: [reconcilerComment('c1', 0, closingCommentWithDuplicate)] };
  assert.deepEqual(changes(told), ['remove label duplicate', 'close']);
});

test('a pull request that is no longer blocked loses its labels and gets a new comment', () => {
  const pr = pullRequest({
    ...carrying(3, 'missing-issue', 'waiting-for-author'),
    comments: [reconcilerComment('c1', 3, `${LIFECYCLE_COMMENT_MARKER}\nA notice.`)],
  });
  const planned = changesOf(pr, plan(pr));
  assert.deepEqual(planned.map(print), [
    'remove label missing-issue',
    'remove label waiting-for-author',
    'create comment',
    'minimize comment c1',
  ]);
  assert.deepEqual(planned[2], { kind: 'create comment', body: RESOLVED_COMMENT_BODY });
});

test('a run that stopped after it told that nothing blocks minimizes the earlier notice', () => {
  const pr = pullRequest({
    comments: [
      reconcilerComment('c1', 3, EARLIER_NOTICE),
      reconcilerComment('c2', 0, RESOLVED_COMMENT_BODY),
    ],
  });
  assert.deepEqual(changes(pr), ['minimize comment c1']);
});

test('a minimized comment is neither edited nor kept as the notice', () => {
  const pr = pullRequest({
    ...withoutIssue,
    ...carrying(3, 'missing-issue', 'waiting-for-author'),
  });
  const minimized = { ...reconcilerComment('c2', 1, EARLIER_NOTICE), isMinimized: true };
  const withVisibleNotice = {
    ...pr,
    comments: [reconcilerComment('c1', 2, EARLIER_NOTICE), minimized],
  };
  assert.deepEqual(changes(withVisibleNotice), ['edit comment c1']);
  assert.deepEqual(changes({ ...pr, comments: [minimized] }), []);
});

test('a pull request that carries do-not-expire is told of no deadline', () => {
  const pr = pullRequest({ ...withoutIssue, labels: ['do-not-expire'] });
  assert.match(plan(pr).comment!, /no issue is linked/);
  assert.doesNotMatch(plan(pr).comment!, /is closed/);
});

test('a pull request that was told that nothing blocks it has no change', () => {
  const pr = pullRequest({ comments: [reconcilerComment('c1', 1, RESOLVED_COMMENT_BODY)] });
  assert.deepEqual(changes(pr), []);
});

test('the comment of a replaced action stays when nothing blocks the pull request', () => {
  const pr = pullRequest({
    comments: [
      reconcilerComment('c1', 3, '<!-- jaeger-pr-linked-issue -->\nThis PR links no issue.'),
    ],
  });
  assert.deepEqual(changes(pr), []);
});

const quiet = {
  createdAt: daysAgo(90),
  commits: [{ ...pullRequest().commits[0]!, committedDate: daysAgo(61) }],
};

test('a pull request on which nobody acted for 60 days is labelled stale and told', () => {
  assert.deepEqual(changes(pullRequest(quiet)), ['add label stale', 'create comment']);
});

test('a comment of a bot is no activity on an idle pull request', () => {
  const pr = pullRequest({
    ...quiet,
    comments: [
      { author: 'codecov', authorIsBot: true, createdAt: daysAgo(2), id: 'c1', isMinimized: false },
    ],
  });
  assert.deepEqual(changes(pr), ['add label stale', 'create comment']);
});

test('a pull request that carries do-not-expire is neither stale nor closed', () => {
  const pr = pullRequest({ ...quiet, labels: ['do-not-expire'] });
  assert.deepEqual(changes(pr), []);
});

test('an idle pull request is closed 14 days after it was labelled stale', () => {
  const pr = pullRequest({ ...quiet, ...carrying(15, 'stale') });
  assert.deepEqual(changes(pr), ['create comment', 'close']);
  assert.deepEqual(changes(pullRequest({ ...quiet, ...carrying(13, 'stale') })), [
    'create comment',
  ]);
});

test('the younger of two pull requests of one issue is labelled duplicate', () => {
  const older = pullRequest({ number: 1, createdAt: daysAgo(20) });
  const younger = pullRequest({ number: 2, createdAt: daysAgo(10) });
  assert.deepEqual(changes(older, [younger]), []);
  assert.deepEqual(changes(younger, [older]), [
    'add label duplicate',
    'add label waiting-for-author',
    'create comment',
  ]);
});
