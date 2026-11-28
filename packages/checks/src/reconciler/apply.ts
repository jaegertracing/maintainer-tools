// The applying half of a run in write mode: it makes the changes of each
// pull request on GitHub, in the order in which the difference lists them.
// See "What is not declarative" in RFC 0003.

import type { OwnedLabel } from '../rules/model.js';
import type { PullRequest } from '../types.js';
import type { Reconciliation } from './reconcile.js';

export type PullRequestRef = Pick<PullRequest, 'repo' | 'number'>;

// The six changes as GitHub accepts them, and the one question that a run
// asks before it makes them. A run in write mode implements the interface
// over GraphQL, and the tests over a stand-in that keeps the pull requests
// in memory.
export interface ChangeWriter {
  // Whether the pull request is open now. A run observes the pull requests
  // minutes before it changes the last of them.
  isOpen(pr: PullRequestRef): Promise<boolean>;
  addLabel(pr: PullRequestRef, label: OwnedLabel): Promise<void>;
  removeLabel(pr: PullRequestRef, label: OwnedLabel): Promise<void>;
  createComment(pr: PullRequestRef, body: string): Promise<void>;
  editComment(commentId: string, body: string): Promise<void>;
  minimizeComment(commentId: string): Promise<void>;
  close(pr: PullRequestRef): Promise<void>;
}

// GitHub accepts 500 requests that create content in an hour, and it does
// not say which changes count. A run therefore makes at most this many
// changes, and the next run makes the rest.
export const MAX_CHANGES_PER_RUN = 400;

export interface AppliedChanges {
  changesMade: number;
  // The pull requests whose changes did not fit into the run.
  postponed: PullRequestRef[];
  // The pull requests that were closed or merged after the run observed
  // them. The run changes none of them.
  noLongerOpen: PullRequestRef[];
}

// Makes the changes of each reconciliation. A change that GitHub refuses
// ends the run with an error: the later changes of the pull request depend
// on it, and the next run observes what was made and makes the rest.
// `pause` runs after each change, because GitHub asks for a second between
// two requests that change something.
export async function applyChanges(
  reconciliations: readonly Reconciliation[],
  writer: ChangeWriter,
  pause: () => Promise<void>,
): Promise<AppliedChanges> {
  let changesMade = 0;
  const postponed: PullRequestRef[] = [];
  const noLongerOpen: PullRequestRef[] = [];
  for (const { pr, changes } of reconciliations) {
    if (changes.length === 0) continue;
    const ref = { repo: pr.repo, number: pr.number };
    // The changes of one pull request are made in one run or in none, so
    // that a label and the comment that explains it are seconds apart.
    if (postponed.length > 0 || changesMade + changes.length > MAX_CHANGES_PER_RUN) {
      postponed.push(ref);
      continue;
    }
    // A comment that says "this pull request is closed" must not reach a
    // pull request that its author closed or a maintainer merged meanwhile.
    if (!(await writer.isOpen(ref))) {
      noLongerOpen.push(ref);
      continue;
    }
    for (const change of changes) {
      try {
        switch (change.kind) {
          case 'add label':
            await writer.addLabel(pr, change.label);
            break;
          case 'remove label':
            await writer.removeLabel(pr, change.label);
            break;
          case 'create comment':
            await writer.createComment(pr, change.body);
            break;
          case 'edit comment':
            await writer.editComment(change.id, change.body);
            break;
          case 'minimize comment':
            await writer.minimizeComment(change.id);
            break;
          case 'close':
            await writer.close(pr);
            break;
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${pr.repo.owner}/${pr.repo.name}#${pr.number}: "${change.kind}" failed after ${changesMade} change(s) of the run: ${reason}`,
          { cause: err },
        );
      }
      changesMade++;
      await pause();
    }
  }
  return { changesMade, postponed, noLongerOpen };
}
