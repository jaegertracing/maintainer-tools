// A triage run can save everything that it takes from GitHub and from the
// clock to a file, and a later run can classify that file instead of asking
// GitHub. See "Comparing two versions of the classifier" in ARCHITECTURE.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  refKey,
  type GraphqlClient,
  type IssueMeta,
  type PrSummary,
  type PullRequest,
} from '@jaegertracing/maintainer-tools-checks';

import { log } from './log.js';

// A TriageSnapshot is everything that a triage run takes from GitHub and from
// the clock, as plain data. A run that loads the snapshot from a file makes no
// GitHub call, so the same file and the same config always give the same
// report.
export interface TriageSnapshot {
  // The clock of the run, as an ISO 8601 time.
  now: string;
  // Login of the maintainer that the report is for.
  viewer: string;
  // The open pull requests as GitHub returned them, without `computed`.
  pullRequests: PullRequest[];
  // Merged-PR count of each author that can exceed a quota, keyed by
  // `owner/repo|login`. Absent when the run skipped the quota (--no-quota).
  mergedCounts?: Record<string, number>;
  // Metadata of each issue that a pull request claims to close, keyed by
  // `refKey()`. An issue that GitHub did not resolve has no entry. Absent
  // when the run skipped the issues (--no-issues).
  issues?: Record<string, IssueMeta>;
}

// A TriageSource is where a triage run takes its data from: GitHub or a
// snapshot file. The run chooses one source at its start and reads it from
// then on, so no later step asks which of the two it is.
export interface TriageSource {
  client: GraphqlClient;
  // The run reads this clock once, after it has fetched everything.
  clock: () => Date;
  // The viewer when the command line or the config names one. The client is
  // asked otherwise.
  viewer?: string;
  useCache: boolean;
  skipQuota: boolean;
  skipIssues: boolean;
  // Present when the run saves its snapshot. The run calls it once it has
  // fetched everything.
  saveSnapshot?: (viewer: string, now: Date) => void;
}

// The source of a run that classifies a snapshot file. A snapshot that was
// saved without the merged counts or the issues skips those passes.
//
// The run scans the repositories of the config, `repos`, so a pull request of
// any other repository would be left out of the report, and the run would not
// say so. Two versions of the code would then agree on a report that misses
// it.
export function snapshotSource(path: string, repos: string[]): TriageSource {
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as TriageSnapshot;
  if (
    !Array.isArray(snapshot.pullRequests) ||
    typeof snapshot.viewer !== 'string' ||
    Number.isNaN(Date.parse(snapshot.now))
  ) {
    throw new Error(`${path} is not a snapshot written by --save-snapshot.`);
  }
  const unlistedRepo = snapshot.pullRequests
    .map((pr) => `${pr.repo.owner}/${pr.repo.name}`)
    .find((repo) => !repos.includes(repo));
  if (unlistedRepo) {
    throw new Error(
      `${path} holds pull requests of ${unlistedRepo}, which the config does not list.`,
    );
  }
  return {
    client: snapshotClient(snapshot),
    clock: () => new Date(snapshot.now),
    useCache: false,
    skipQuota: !snapshot.mergedCounts,
    skipIssues: !snapshot.issues,
  };
}

// Returns `source` changed so that the run also writes its snapshot to
// `path`. The run does not use the cache, because an answer that comes from
// the cache never reaches the client that records the answers.
export function sourceSavingSnapshot(source: TriageSource, path: string): TriageSource {
  const answers: GitHubAnswers = { pullRequests: [], mergedCounts: {}, issues: {} };
  return {
    ...source,
    client: recordingClient(source.client, answers),
    useCache: false,
    saveSnapshot(viewer, now) {
      const snapshot: TriageSnapshot = {
        now: now.toISOString(),
        viewer,
        pullRequests: answers.pullRequests,
        mergedCounts: source.skipQuota ? undefined : answers.mergedCounts,
        issues: source.skipIssues ? undefined : answers.issues,
      };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
      log(`wrote snapshot ${path}`);
    },
  };
}

// The part of a snapshot that a run asks from GitHub while it scans and
// enriches the pull requests.
export type GitHubAnswers = Required<
  Pick<TriageSnapshot, 'pullRequests' | 'mergedCounts' | 'issues'>
>;

// recordingClient() exists because the functions that fetch the merged counts
// and the issues do not return them: they only annotate the pull requests.
// The returned client passes every call on to `client` and stores each answer
// in `answers`.
export function recordingClient(client: GraphqlClient, answers: GitHubAnswers): GraphqlClient {
  return {
    fetchViewerLogin: () => client.fetchViewerLogin(),
    listOpenPRs: (owner, repo) => client.listOpenPRs(owner, repo),
    listOpenPRsByLabel: (owner, repo, label) => client.listOpenPRsByLabel(owner, repo, label),
    async fetchPullRequest(owner, repo, number) {
      const pr = await client.fetchPullRequest(owner, repo, number);
      // The run annotates the pull request that it receives, and the snapshot
      // holds it as fetched.
      answers.pullRequests.push(structuredClone(pr));
      return pr;
    },
    async countMergedPRs(owner, repo, author) {
      const count = await client.countMergedPRs(owner, repo, author);
      answers.mergedCounts[mergedCountKey(owner, repo, author)] = count;
      return count;
    },
    async fetchIssues(refs) {
      const issues = await client.fetchIssues(refs);
      Object.assign(answers.issues, Object.fromEntries(issues));
      return issues;
    },
  };
}

// snapshotClient() answers each question that a triage run asks GitHub by
// looking the answer up in the snapshot, so that the run takes the same code
// path as a run against GitHub.
export function snapshotClient(snapshot: TriageSnapshot): GraphqlClient {
  const openPRs = (owner: string, repo: string): PullRequest[] =>
    snapshot.pullRequests.filter((pr) => pr.repo.owner === owner && pr.repo.name === repo);
  return {
    fetchViewerLogin: async () => snapshot.viewer,
    listOpenPRs: async (owner, repo) => openPRs(owner, repo).map(prSummary),
    listOpenPRsByLabel: async (owner, repo, label) =>
      openPRs(owner, repo)
        .filter((pr) => pr.labels.includes(label))
        .map(prSummary),
    async fetchPullRequest(owner, repo, number) {
      const pr = openPRs(owner, repo).find((candidate) => candidate.number === number);
      if (!pr) throw new Error(`the snapshot has no pull request ${owner}/${repo}#${number}`);
      return pr;
    },
    async countMergedPRs(owner, repo, author) {
      const count = snapshot.mergedCounts?.[mergedCountKey(owner, repo, author)];
      if (count === undefined) {
        throw new Error(
          `the snapshot has no merged-PR count for @${author} in ${owner}/${repo}; ` +
            'it was saved with a config that exempts this author from the quota',
        );
      }
      return count;
    },
    async fetchIssues(refs) {
      const issues = new Map<string, IssueMeta>();
      for (const ref of refs) {
        const key = refKey(ref);
        const meta = snapshot.issues?.[key];
        if (meta) issues.set(key, meta);
      }
      return issues;
    },
  };
}

function mergedCountKey(owner: string, repo: string, author: string): string {
  return `${owner}/${repo}|${author}`;
}

function prSummary(pr: PullRequest): PrSummary {
  return {
    number: pr.number,
    updatedAt: pr.updatedAt,
    headSha: pr.commits[pr.commits.length - 1]?.sha ?? null,
    headRollup: pr.statusCheckRollup,
  };
}
