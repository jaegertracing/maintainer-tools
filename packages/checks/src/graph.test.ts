import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTreeEntryModified,
  verifyCommitAncestor,
  hasQualifyingAuthorAuthoredCommit,
} from './graph.js';
import type { CommitPathComparison } from './graphql.js';
import type { PullRequest } from './types.js';

function createMockPr(overrides?: Partial<PullRequest>): PullRequest {
  return {
    repo: { owner: 'jaegertracing', name: 'jaeger' },
    number: 100,
    title: 'Test PR',
    url: 'https://github.com/jaegertracing/jaeger/pull/100',
    headRefOid: 'head-sha',
    baseRefOid: 'base-sha',
    author: { login: 'alice', typename: 'User' },
    authorAssociation: 'CONTRIBUTOR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    labels: [],
    additions: 10,
    deletions: 0,
    changedFiles: 1,
    files: ['packages/checks/src/actor.ts'],
    statusCheckRollup: 'SUCCESS',
    commits: [],
    commitsTruncated: false,
    reviewRequests: [],
    reviewRequestsTruncated: false,
    reviews: [],
    reviewsTruncated: false,
    comments: [],
    commentsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
    ...overrides,
  };
}

test('isTreeEntryModified detects added file (absent in parent, found in candidate)', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
    parentResult: { status: 'absent' },
  };
  assert.equal(isTreeEntryModified(comp), true);
});

test('isTreeEntryModified detects deleted file (found in parent, absent in candidate)', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: { status: 'absent' },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  };
  assert.equal(isTreeEntryModified(comp), true);
});

test('isTreeEntryModified detects modified file (different blob OIDs)', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-2', mode: 100644, type: 'blob' },
    },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  };
  assert.equal(isTreeEntryModified(comp), true);
});

test('isTreeEntryModified detects unchanged file (identical blob OIDs)', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  };
  assert.equal(isTreeEntryModified(comp), false);
});

test('isTreeEntryModified fails closed to unavailable when candidate result is unavailable', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: { status: 'unavailable', message: 'timeout' },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  };
  assert.equal(isTreeEntryModified(comp), 'unavailable');
});

test('isTreeEntryModified fails closed to unavailable when parent result is unavailable', () => {
  const comp: CommitPathComparison = {
    candidateOid: 'c1',
    parentOid: 'p1',
    path: 'foo.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
    parentResult: { status: 'unavailable', message: 'rate limit' },
  };
  assert.equal(isTreeEntryModified(comp), 'unavailable');
});

test('verifyCommitAncestor returns ancestor with empty range when ancestorOid equals descendantOid', () => {
  const pr = createMockPr({ headRefOid: 'sha-1' });
  const result = verifyCommitAncestor(pr, 'sha-1', 'sha-1');
  assert.deepEqual(result, {
    status: 'ancestor',
    rangeCommits: [],
    rangeComplete: true,
  });
});

test('verifyCommitAncestor returns indeterminate when descendant is not in pr.commits and no external parents', () => {
  const pr = createMockPr({ commits: [] });
  const result = verifyCommitAncestor(pr, 'sha-1', 'sha-missing');
  assert.deepEqual(result, {
    status: 'indeterminate',
    reason: 'descendant_commit_missing',
  });
});

test('verifyCommitAncestor verifies simple linear ancestry: C1 -> C2 -> C3', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'feat: part 1',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T01:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'feat: part 2',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c3: PullRequest['commits'][number] = {
    sha: 'c3',
    messageHeadline: 'feat: part 3',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T03:00:00Z',
    parents: 1,
    parentOids: ['c2'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = createMockPr({
    headRefOid: 'c3',
    baseRefOid: 'base-sha',
    commits: [c1, c2, c3],
  });

  const res = verifyCommitAncestor(pr, 'c1', 'c3');
  assert.equal(res.status, 'ancestor');
  if (res.status === 'ancestor') {
    assert.deepEqual(
      res.rangeCommits.map((c) => c.sha),
      ['c3', 'c2'],
    );
    assert.equal(res.rangeComplete, true);
  }
});

test('verifyCommitAncestor returns not_ancestor when ancestor is along a divergent branch', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'base commit',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T01:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'head commit',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const cOther: PullRequest['commits'][number] = {
    sha: 'c_other',
    messageHeadline: 'abandoned commit',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T01:30:00Z',
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pr = createMockPr({
    headRefOid: 'c2',
    baseRefOid: 'base-sha',
    commits: [c1, c2, cOther],
  });

  const res = verifyCommitAncestor(pr, 'c_other', 'c2');
  assert.equal(res.status, 'not_ancestor');
});

test('verifyCommitAncestor handles merge DAG traversal and visits shared ancestor once', () => {
  const c0: PullRequest['commits'][number] = {
    sha: 'c0',
    messageHeadline: 'c0',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T00:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'c1',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T01:00:00Z',
    parents: 1,
    parentOids: ['c0'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'c2',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['c0'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c3: PullRequest['commits'][number] = {
    sha: 'c3',
    messageHeadline: 'c3 merge',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T03:00:00Z',
    parents: 2,
    parentOids: ['c1', 'c2'],
    parentsTruncated: false,
    changedFilesIfAvailable: 2,
  };

  const pr = createMockPr({
    headRefOid: 'c3',
    baseRefOid: 'base-sha',
    commits: [c0, c1, c2, c3],
  });

  const res = verifyCommitAncestor(pr, 'c0', 'c3');
  assert.equal(res.status, 'ancestor');
  if (res.status === 'ancestor') {
    assert.deepEqual(
      res.rangeCommits.map((c) => c.sha),
      ['c3', 'c1', 'c2'],
    );
    assert.equal(res.rangeComplete, true);
  }
});

test('verifyCommitAncestor fails closed to indeterminate when maxVisitedCommits is exceeded', () => {
  const c1: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'c1',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T01:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c2: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'c2',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const c3: PullRequest['commits'][number] = {
    sha: 'c3',
    messageHeadline: 'c3',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T03:00:00Z',
    parents: 1,
    parentOids: ['c2'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const pr = createMockPr({ commits: [c1, c2, c3] });

  const res = verifyCommitAncestor(pr, 'c1', 'c3', { limits: { maxVisitedCommits: 1 } });
  assert.equal(res.status, 'indeterminate');
  if (res.status === 'indeterminate') {
    assert.equal(res.reason, 'max_visited_commits_reached');
  }
});

test('hasQualifyingAuthorAuthoredCommit qualifies a non-merge author commit with changes', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'fix: address feedback',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [c], true);
  assert.deepEqual(res, { status: 'qualifying', commit: c });
});

test('hasQualifyingAuthorAuthoredCommit rejects a merge commit (parents > 1)', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'Merge branch main',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 2,
    parentOids: ['p1', 'p2'],
    parentsTruncated: false,
    changedFilesIfAvailable: 5,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [c], true);
  assert.deepEqual(res, { status: 'no_qualifying_commit' });
});

test('hasQualifyingAuthorAuthoredCommit rejects an empty commit (changedFilesIfAvailable === 0)', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'empty commit',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 0,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [c], true);
  assert.deepEqual(res, { status: 'no_qualifying_commit' });
});

test('hasQualifyingAuthorAuthoredCommit fails closed to indeterminate when changedFilesIfAvailable is null', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'commit with missing stats',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: null,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [c], true);
  assert.equal(res.status, 'indeterminate');
});

test('hasQualifyingAuthorAuthoredCommit treats an unlinked non-merge author as indeterminate', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'fix: address feedback',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: null,
    authorTypename: null,
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [c], true);
  assert.equal(res.status, 'indeterminate');
});

test('hasQualifyingAuthorAuthoredCommit rejects a commit authored by another user or bot', () => {
  const pr = createMockPr();
  const cBot: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'bot commit',
    messageBody: '',
    authorEmail: 'bot@example.com',
    authorLogin: 'renovate[bot]',
    authorTypename: 'Bot',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 2,
  };
  const cCollab: PullRequest['commits'][number] = {
    sha: 'c2',
    messageHeadline: 'maintainer commit',
    messageBody: '',
    authorEmail: 'bob@example.com',
    authorLogin: 'bob',
    authorTypename: 'User',
    committedDate: '2026-03-01T03:00:00Z',
    parents: 1,
    parentOids: ['c1'],
    parentsTruncated: false,
    changedFilesIfAvailable: 2,
  };
  const res = hasQualifyingAuthorAuthoredCommit(pr, [cBot, cCollab], true);
  assert.deepEqual(res, { status: 'no_qualifying_commit' });
});

test('hasQualifyingAuthorAuthoredCommit respects threadPath relevance using pathComparisonMap', () => {
  const pr = createMockPr();
  const c: PullRequest['commits'][number] = {
    sha: 'c1',
    messageHeadline: 'fix: updated actor.ts',
    messageBody: '',
    authorEmail: 'alice@example.com',
    authorLogin: 'alice',
    authorTypename: 'User',
    committedDate: '2026-03-01T02:00:00Z',
    parents: 1,
    parentOids: ['base-sha'],
    parentsTruncated: false,
    changedFilesIfAvailable: 1,
  };

  const pathMap = new Map<string, CommitPathComparison>();
  pathMap.set('packages/checks/src/actor.ts', {
    candidateOid: 'c1',
    parentOid: 'base-sha',
    path: 'packages/checks/src/actor.ts',
    candidateResult: {
      status: 'found',
      entry: { oid: 'blob-2', mode: 100644, type: 'blob' },
    },
    parentResult: {
      status: 'found',
      entry: { oid: 'blob-1', mode: 100644, type: 'blob' },
    },
  });

  const resMatch = hasQualifyingAuthorAuthoredCommit(
    pr,
    [c],
    true,
    'packages/checks/src/actor.ts',
    pathMap,
  );
  assert.deepEqual(resMatch, { status: 'qualifying', commit: c });

  const resUnrelated = hasQualifyingAuthorAuthoredCommit(
    pr,
    [c],
    true,
    'packages/checks/src/buckets.ts',
    pathMap,
  );
  assert.equal(resUnrelated.status, 'indeterminate');
});
