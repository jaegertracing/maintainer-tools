import type { CommitPathComparison } from './graphql.js';
import { sameLogin } from './logins.js';
import type { PullRequest } from './types.js';

export interface TraversalLimits {
  maxVisitedCommits?: number;
  maxGraphRequests?: number;
}

export type AncestryResult =
  | {
      status: 'ancestor';
      rangeCommits: PullRequest['commits'][number][];
      rangeComplete: boolean;
    }
  | { status: 'not_ancestor' }
  | { status: 'indeterminate'; reason: string };

export interface ExternalCommitNode {
  parentOids: string[];
  parentsTruncated?: boolean;
}

export interface VerifyAncestorOptions {
  limits?: TraversalLimits;
  externalParents?: Map<string, ExternalCommitNode>;
}

export type QualifyingCommitResult =
  | { status: 'qualifying'; commit: PullRequest['commits'][number] }
  | { status: 'no_qualifying_commit' }
  | { status: 'indeterminate'; reason: string };

/**
 * Evaluates whether a TreeEntry comparison reflects a modification, addition, deletion,
 * or whether comparison metadata is unavailable.
 */
export function isTreeEntryModified(comp: CommitPathComparison): boolean | 'unavailable' {
  if (comp.candidateResult.status === 'unavailable' || comp.parentResult.status === 'unavailable') {
    return 'unavailable';
  }

  // 1. Added: not in parent, exists in candidate
  if (comp.parentResult.status === 'absent' && comp.candidateResult.status === 'found') {
    return true;
  }
  // 2. Deleted: existed in parent, absent in candidate
  if (comp.parentResult.status === 'found' && comp.candidateResult.status === 'absent') {
    return true;
  }
  // 3. Both found: any tree-entry identity change modifies the path
  if (comp.parentResult.status === 'found' && comp.candidateResult.status === 'found') {
    return (
      comp.candidateResult.entry.oid !== comp.parentResult.entry.oid ||
      comp.candidateResult.entry.mode !== comp.parentResult.entry.mode ||
      comp.candidateResult.entry.type !== comp.parentResult.entry.type
    );
  }
  // 4. Neither found: path did not exist in either tree (unchanged absent)
  return false;
}

/**
 * Computes whether ancestorOid is an ancestor of descendantOid within the PR's commit graph,
 * respecting the base boundary stopping rule and returning Reach(descendantOid) \ Reach(ancestorOid).
 */
export function verifyCommitAncestor(
  pr: PullRequest,
  ancestorOid: string,
  descendantOid: string,
  options?: VerifyAncestorOptions,
): AncestryResult {
  if (!ancestorOid || !descendantOid) {
    return { status: 'indeterminate', reason: 'missing_oid' };
  }

  // Same commit: distance is 0, no intervening commits
  if (ancestorOid === descendantOid) {
    return { status: 'ancestor', rangeCommits: [], rangeComplete: true };
  }

  const maxVisitedCommits = options?.limits?.maxVisitedCommits ?? 50;
  const externalParents = options?.externalParents;

  const commitByOid = new Map<string, PullRequest['commits'][number]>();
  for (const c of pr.commits) {
    commitByOid.set(c.sha, c);
  }

  // Check descendant presence
  const isDescendantInPr = commitByOid.has(descendantOid);
  const isDescendantExternal = externalParents?.has(descendantOid);
  if (!isDescendantInPr && !isDescendantExternal) {
    return { status: 'indeterminate', reason: 'descendant_commit_missing' };
  }

  // Pre-compute Reach(ancestorOid) within known commits to exclude shared ancestors
  const ancestorReach = new Set<string>();
  let ancestorReachComplete = true;

  if (commitByOid.has(ancestorOid)) {
    const queue = [ancestorOid];
    const visited = new Set<string>([ancestorOid]);
    ancestorReach.add(ancestorOid);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const c = commitByOid.get(curr);
      if (c) {
        if (c.parentsTruncated) {
          ancestorReachComplete = false;
        }
        for (const p of c.parentOids ?? []) {
          if (p === pr.baseRefOid) {
            continue; // Entered base history
          }
          if (commitByOid.has(p)) {
            if (!visited.has(p)) {
              visited.add(p);
              ancestorReach.add(p);
              queue.push(p);
            }
          } else {
            // Parent is outside pr.commits
            if (externalParents?.has(p)) {
              if (!visited.has(p)) {
                visited.add(p);
                ancestorReach.add(p);
                queue.push(p);
              }
            } else {
              // Could have ancestors outside pr.commits
              ancestorReachComplete = false;
            }
          }
        }
      } else if (externalParents?.has(curr)) {
        const ext = externalParents.get(curr)!;
        if (ext.parentsTruncated) {
          ancestorReachComplete = false;
        }
        for (const p of ext.parentOids) {
          if (!visited.has(p)) {
            visited.add(p);
            ancestorReach.add(p);
            queue.push(p);
          }
        }
      }
    }
  }

  // Main traversal backward from descendantOid
  const queue = [descendantOid];
  const visited = new Set<string>([descendantOid]);
  const rangeCommits: PullRequest['commits'][number][] = [];
  let foundAncestor = false;
  let rangeComplete = true;
  let visitedCount = 0;

  while (queue.length > 0) {
    const currOid = queue.shift()!;
    visitedCount++;

    if (visitedCount > maxVisitedCommits) {
      return { status: 'indeterminate', reason: 'max_visited_commits_reached' };
    }

    if (currOid === ancestorOid) {
      foundAncestor = true;
      // Do not add ancestor to rangeCommits and do not traverse its parents
      continue;
    }

    if (ancestorReach.has(currOid)) {
      // Shared ancestor reachable from ancestorOid: exclude from rangeCommits
      continue;
    }

    const prCommit = commitByOid.get(currOid);
    if (prCommit) {
      rangeCommits.push(prCommit);

      if (prCommit.parentsTruncated) {
        rangeComplete = false;
      }

      for (const parentOid of prCommit.parentOids ?? []) {
        if (parentOid === ancestorOid) {
          foundAncestor = true;
          continue;
        }

        if (ancestorReach.has(parentOid)) {
          // Do not traverse into shared ancestor history
          continue;
        }

        if (commitByOid.has(parentOid)) {
          if (!visited.has(parentOid)) {
            visited.add(parentOid);
            queue.push(parentOid);
          }
        } else if (parentOid === pr.baseRefOid) {
          // Base boundary reached!
          if (ancestorOid === pr.baseRefOid) {
            foundAncestor = true;
          } else if (!commitByOid.has(ancestorOid)) {
            // The requested ancestor may be older than the base commit and is
            // therefore outside the fetched PR graph. Without the base
            // history, this is unknown rather than proof of non-ancestry.
            rangeComplete = false;
          }
        } else if (externalParents?.has(parentOid)) {
          if (!visited.has(parentOid)) {
            visited.add(parentOid);
            queue.push(parentOid);
          }
        } else {
          // Parent is outside pr.commits and not in externalParents
          if (commitByOid.has(ancestorOid)) {
            // Ancestor is inside pr.commits, so entering base cannot reach ancestor.
            // Branch terminates cleanly by Stopping Boundary Theorem.
          } else {
            // Ancestor is outside pr.commits; it might be reachable down this base branch.
            rangeComplete = false;
          }
        }
      }
    } else if (externalParents?.has(currOid)) {
      const ext = externalParents.get(currOid)!;
      if (ext.parentsTruncated) {
        rangeComplete = false;
      }
      for (const parentOid of ext.parentOids) {
        if (parentOid === ancestorOid) {
          foundAncestor = true;
          continue;
        }
        if (ancestorReach.has(parentOid)) {
          continue;
        }
        if (!visited.has(parentOid)) {
          visited.add(parentOid);
          queue.push(parentOid);
        }
      }
    } else {
      // Node cannot be expanded
      rangeComplete = false;
    }
  }

  if (foundAncestor) {
    if (!ancestorReachComplete) {
      rangeComplete = false;
    }
    return {
      status: 'ancestor',
      rangeCommits,
      rangeComplete,
    };
  }

  // Not encountered along any explored path
  if (!rangeComplete || pr.commitsTruncated !== false) {
    return { status: 'indeterminate', reason: 'incomplete_commit_graph' };
  }

  return { status: 'not_ancestor' };
}

/**
 * Evaluates whether rangeCommits contains a qualifying author-authored code update.
 * When threadPath is supplied, checks whether any qualifying commit touches threadPath.
 */
export function hasQualifyingAuthorAuthoredCommit(
  pr: PullRequest,
  rangeCommits: PullRequest['commits'][number][],
  rangeComplete: boolean,
  threadPath?: string,
  pathComparisonMap?: Map<string, CommitPathComparison>,
): QualifyingCommitResult {
  const authorLogin = pr.author?.login;
  if (!authorLogin) {
    return { status: 'indeterminate', reason: 'author_identity_unavailable' };
  }

  let hasIndeterminateCommit = false;
  for (const c of rangeCommits) {
    // 1. Author identity verification
    if (!c.authorLogin) {
      // A missing user link cannot prove whether this commit belongs to the PR author.
      if (c.parents <= 1) {
        hasIndeterminateCommit = true;
      }
      continue;
    }
    if (!sameLogin(c.authorLogin, authorLogin)) {
      // Collaborator or bot, not the PR author
      continue;
    }
    if (c.authorTypename !== 'User' && c.authorTypename !== 'EnterpriseUserAccount') {
      if (!c.authorTypename) {
        hasIndeterminateCommit = true;
      }
      continue;
    }

    // 2. Non-merge commit
    if (c.parents > 1) {
      continue;
    }

    // 3. Changed files check
    if (c.changedFilesIfAvailable === null || c.changedFilesIfAvailable === undefined) {
      hasIndeterminateCommit = true;
      continue;
    }
    if (c.changedFilesIfAvailable === 0) {
      // Empty commit does not qualify
      continue;
    }

    // 4. Path relevance check if threadPath is provided
    if (threadPath !== undefined) {
      if (!pathComparisonMap) {
        hasIndeterminateCommit = true;
        continue;
      }
      const comp =
        pathComparisonMap.get(`${c.sha}:${threadPath}`) ?? pathComparisonMap.get(threadPath);
      if (!comp) {
        // A comparison for another path or commit does not establish whether
        // this commit touched the requested thread path.
        hasIndeterminateCommit = true;
        continue;
      }
      const parentMatches =
        comp.parentOid === null ? c.parents === 0 : (c.parentOids ?? []).includes(comp.parentOid);
      if (comp.candidateOid !== c.sha || !parentMatches) {
        // The comparison may describe another commit in a multi-commit
        // response range. Fail closed rather than treating this candidate as
        // definitively unrelated to the thread path.
        hasIndeterminateCommit = true;
        continue;
      }
      const mod = isTreeEntryModified(comp);
      if (mod === 'unavailable') {
        hasIndeterminateCommit = true;
        continue;
      }
      if (!mod) {
        // Path was not touched by this commit
        continue;
      }
    }

    // Qualifying author commit found!
    return { status: 'qualifying', commit: c };
  }

  if (hasIndeterminateCommit) {
    return { status: 'indeterminate', reason: 'indeterminate_commit_evidence' };
  }

  if (!rangeComplete) {
    return { status: 'indeterminate', reason: 'incomplete_range' };
  }

  return { status: 'no_qualifying_commit' };
}
