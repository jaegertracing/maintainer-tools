import assert from 'node:assert/strict';
import test from 'node:test';

import { LIFECYCLE_COMMENT_MARKER } from '../policy-comments.js';
import type { OwnedLabel } from '../rules/model.js';
import { DEFAULT_POLICY_AGES } from '../types.js';
import type { PullRequest } from '../types.js';
import { applyChanges, MAX_CHANGES_PER_RUN } from './apply.js';
import type { ChangeWriter, PullRequestRef } from './apply.js';
import {
  approvedIssue,
  carrying,
  daysAgo,
  NOW,
  pullRequest,
  unapprovedIssue,
} from './pull-request-fixture.js';
import { reconcile } from './reconcile.js';
import type { Reconciliation } from './reconcile.js';

const noPause = async (): Promise<void> => {};

// A stand-in for GitHub that keeps the pull requests in memory. It makes
// each change as GitHub does: a label change adds a label event, and a new
// comment is one of the bot of GitHub Actions.
class GitHubStandIn implements ChangeWriter {
  now = NOW;
  // The names of the changes, in the order in which the stand-in got them.
  readonly changesReceived: string[] = [];
  // The stand-in refuses the change with this index, counted from zero.
  refusedChange: number | undefined;
  private readonly closedNumbers = new Set<number>();

  constructor(private readonly pullRequests: PullRequest[]) {}

  openPullRequests(): PullRequest[] {
    return this.pullRequests.filter((pr) => !this.closedNumbers.has(pr.number));
  }

  // The author closes the pull request, or a maintainer merges it.
  closedByPerson(number: number): void {
    this.closedNumbers.add(number);
  }

  async isOpen(ref: PullRequestRef): Promise<boolean> {
    return !this.closedNumbers.has(ref.number);
  }

  // What a person sees on each pull request: the texts of its visible
  // comments, whether it is open, and the labels of an open one. The labels
  // of a closed pull request stay as the last run before the closing left
  // them. The reasons that a comment lists are left out, because they
  // depend on which other pull requests were open when it was written.
  visibleState(): unknown {
    return this.pullRequests.map((pr) => ({
      number: pr.number,
      labels: this.closedNumbers.has(pr.number) ? 'closed' : [...pr.labels].sort(),
      visibleComments: pr.comments
        .filter((comment) => !comment.isMinimized)
        .map((comment) =>
          comment
            .body!.split('\n')
            .filter((line) => !line.startsWith('- '))
            .join('\n'),
        ),
      comments: pr.comments.length,
      isOpen: !this.closedNumbers.has(pr.number),
    }));
  }

  private receiveChange(change: string): void {
    if (this.changesReceived.length === this.refusedChange) {
      this.refusedChange = undefined;
      throw new Error('GitHub is unavailable');
    }
    this.changesReceived.push(change);
  }

  private findPullRequest(ref: PullRequestRef): PullRequest {
    return this.pullRequests.find((pr) => pr.number === ref.number)!;
  }

  private findComment(commentId: string): PullRequest['comments'][number] {
    return this.pullRequests
      .flatMap((pr) => pr.comments)
      .find((comment) => comment.id === commentId)!;
  }

  async addLabel(ref: PullRequestRef, label: OwnedLabel): Promise<void> {
    this.receiveChange(`#${ref.number} add label ${label}`);
    const pr = this.findPullRequest(ref);
    pr.labels.push(label);
    pr.labelEvents!.push({ label, event: 'labeled', at: this.now.toISOString() });
  }

  async removeLabel(ref: PullRequestRef, label: OwnedLabel): Promise<void> {
    this.receiveChange(`#${ref.number} remove label ${label}`);
    const pr = this.findPullRequest(ref);
    pr.labels.splice(pr.labels.indexOf(label), 1);
    pr.labelEvents!.push({ label, event: 'unlabeled', at: this.now.toISOString() });
  }

  async createComment(ref: PullRequestRef, body: string): Promise<void> {
    this.receiveChange(`#${ref.number} create comment`);
    const pr = this.findPullRequest(ref);
    pr.comments.push({
      id: `IC_${ref.number}_${pr.comments.length}`,
      author: 'github-actions',
      authorIsBot: true,
      createdAt: this.now.toISOString(),
      body,
      isMinimized: false,
    });
  }

  async editComment(commentId: string, body: string): Promise<void> {
    this.receiveChange(`edit comment ${commentId}`);
    this.findComment(commentId).body = body;
  }

  async minimizeComment(commentId: string): Promise<void> {
    this.receiveChange(`minimize comment ${commentId}`);
    this.findComment(commentId).isMinimized = true;
  }

  async close(ref: PullRequestRef): Promise<void> {
    this.receiveChange(`#${ref.number} close`);
    this.closedNumbers.add(ref.number);
  }
}

function notice(id: string, days: number): PullRequest['comments'][number] {
  return {
    id,
    author: 'github-actions',
    authorIsBot: true,
    createdAt: daysAgo(days),
    body: `${LIFECYCLE_COMMENT_MARKER}\nAn earlier notice.`,
    isMinimized: false,
  };
}

const withoutIssue = { linkedIssues: [], body: '' };

// One pull request for each path through the difference: a first notice, a
// swap of the flag label, a resolution and a closing.
function gitHubWithSixPullRequests(): GitHubStandIn {
  const author = (number: number): Partial<PullRequest> => ({
    number,
    author: { login: `contributor-${number}`, typename: 'User' },
  });
  return new GitHubStandIn([
    pullRequest({ ...author(1), ...withoutIssue }),
    pullRequest({
      ...author(2),
      ...withoutIssue,
      ...carrying(3, 'unapproved-issue', 'waiting-for-author'),
      comments: [notice('IC_swap', 2)],
    }),
    pullRequest({
      ...author(3),
      linkedIssues: [{ ...approvedIssue, number: 103 }],
      ...carrying(3, 'missing-issue', 'waiting-for-author'),
      comments: [notice('IC_resolved', 2)],
    }),
    pullRequest({
      ...author(4),
      linkedIssues: [{ ...unapprovedIssue, number: 104 }],
      ...carrying(8, 'unapproved-issue', 'waiting-for-author'),
      comments: [notice('IC_closed', 7)],
    }),
    // Two pull requests of one issue. The closing of the older one takes
    // the reason `duplicate` away from the younger one.
    pullRequest({
      ...author(5),
      linkedIssues: [{ ...unapprovedIssue, number: 105 }],
      ...carrying(8, 'unapproved-issue', 'waiting-for-author'),
      comments: [notice('IC_older', 7)],
    }),
    pullRequest({
      ...author(6),
      createdAt: daysAgo(10),
      linkedIssues: [{ ...unapprovedIssue, number: 105 }],
      ...carrying(8, 'unapproved-issue', 'duplicate', 'waiting-for-author'),
      comments: [notice('IC_younger', 7)],
    }),
  ]);
}

// One run in write mode: it derives the changes of the open pull requests
// of the stand-in and applies them.
async function run(gitHub: GitHubStandIn): Promise<number> {
  const reconciliations = reconcile(
    {
      pullRequests: gitHub.openPullRequests(),
      quotaExemptLogins: new Set(),
      collaborators: { 'example/repo': { maintainer: 'ADMIN' } },
    },
    gitHub.now,
    DEFAULT_POLICY_AGES,
  );
  return (await applyChanges(reconciliations, gitHub, noPause)).changesMade;
}

test('a run makes the changes of each pull request in the order of the difference', async () => {
  const gitHub = gitHubWithSixPullRequests();
  await run(gitHub);
  assert.deepEqual(gitHub.changesReceived, [
    '#1 add label missing-issue',
    '#1 add label waiting-for-author',
    '#1 create comment',
    '#2 add label missing-issue',
    '#2 remove label unapproved-issue',
    'edit comment IC_swap',
    '#3 remove label missing-issue',
    '#3 remove label waiting-for-author',
    '#3 create comment',
    'minimize comment IC_resolved',
    '#4 create comment',
    'minimize comment IC_closed',
    '#4 close',
    '#5 create comment',
    'minimize comment IC_older',
    '#5 close',
    '#6 create comment',
    'minimize comment IC_younger',
    '#6 close',
  ]);
});

test('a run changes no pull request that was closed after the run observed it', async () => {
  const gitHub = gitHubWithSixPullRequests();
  const reconciliations = reconcile(
    { pullRequests: gitHub.openPullRequests(), quotaExemptLogins: new Set() },
    NOW,
    DEFAULT_POLICY_AGES,
  );
  gitHub.closedByPerson(4);
  const applied = await applyChanges(reconciliations, gitHub, noPause);

  assert.deepEqual(
    applied.noLongerOpen.map((pr) => pr.number),
    [4],
  );
  assert.deepEqual(
    gitHub.changesReceived.filter((change) => /#4|IC_closed/.test(change)),
    [],
  );
});

test('the run after a run in write mode finds nothing to change', async () => {
  const gitHub = gitHubWithSixPullRequests();
  await run(gitHub);
  gitHub.now = new Date(NOW.getTime() + 60 * 60 * 1000);
  assert.equal(await run(gitHub), 0);
});

test('a run that GitHub stopped at any change is finished by the next run', async () => {
  const uninterrupted = gitHubWithSixPullRequests();
  const changes = await run(uninterrupted);

  for (let refusedChange = 0; refusedChange < changes; refusedChange++) {
    const gitHub = gitHubWithSixPullRequests();
    gitHub.refusedChange = refusedChange;
    await assert.rejects(
      run(gitHub),
      /failed after \d+ change\(s\) of the run: GitHub is unavailable/,
    );
    gitHub.now = new Date(NOW.getTime() + 60 * 1000);
    await run(gitHub);
    assert.deepEqual(
      gitHub.visibleState(),
      uninterrupted.visibleState(),
      `after a run that stopped at change ${refusedChange}`,
    );
    assert.equal(await run(gitHub), 0);
  }
});

test('a run postpones the pull requests whose changes exceed its limit', async () => {
  const reconciliation = (number: number, changes: number): Reconciliation =>
    ({
      pr: pullRequest({ number }),
      changes: Array.from({ length: changes }, (_, index) => ({
        kind: 'minimize comment',
        id: `IC_${number}_${index}`,
      })),
    }) as Reconciliation;
  const applied = await applyChanges(
    [
      reconciliation(1, MAX_CHANGES_PER_RUN - 1),
      reconciliation(2, 2),
      reconciliation(3, 0),
      reconciliation(4, 1),
    ],
    { isOpen: async () => true, minimizeComment: async () => {} } as unknown as ChangeWriter,
    noPause,
  );
  assert.equal(applied.changesMade, MAX_CHANGES_PER_RUN - 1);
  assert.deepEqual(
    applied.postponed.map((pr) => pr.number),
    [2, 4],
  );
});

test('a run pauses after each change', async () => {
  const gitHub = gitHubWithSixPullRequests();
  let pauses = 0;
  const reconciliations = reconcile(
    { pullRequests: gitHub.openPullRequests(), quotaExemptLogins: new Set() },
    NOW,
    DEFAULT_POLICY_AGES,
  );
  const applied = await applyChanges(reconciliations, gitHub, async () => {
    pauses++;
  });
  assert.equal(pauses, applied.changesMade);
});
