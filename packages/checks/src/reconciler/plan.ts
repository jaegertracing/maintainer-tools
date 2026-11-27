// The plan of a pull request: the state that the rules derive for it. It
// holds the labels that the reconciler owns, the text of the comment, and
// whether the pull request is closed.

import { LIFECYCLE_COMMENT_MARKER } from '../policy-comments.js';
import { supportingFacts } from '../rules/evaluate.js';
import type { Verdict } from '../rules/evaluate.js';
import { labelOutputName, OutputName, OWNED_LABELS } from '../rules/model.js';
import type { OwnedLabel } from '../rules/model.js';
import { doNotExpirePredicate } from '../predicates/idle.js';
import type { PolicyAges, PullRequest } from '../types.js';

// The text of the comment that tells the author that the state which an
// earlier comment reported no longer holds.
export const RESOLVED_COMMENT_BODY = `${LIFECYCLE_COMMENT_MARKER}\nThis pull request now meets the contribution policies that the earlier comment reported, and nothing blocks it.`;

// The sentence by which a comment says that it closes the pull request.
export const CLOSING_SENTENCE =
  'pull request is closed, because its notice period has passed and the following still holds.';

export interface Plan {
  // The labels of the reconciler that the pull request should carry.
  labels: OwnedLabel[];
  // The text that the comment should have, or null when the rules derive no
  // comment.
  comment: string | null;
  shouldClose: boolean;
  // Why each output of the plan holds, as the premises of the reasons that
  // held, for the report.
  reasons: Record<string, string[]>;
}

// The sentences that tell the author when the pull request will be closed,
// one for each notice period that runs.
function deadlines(labels: readonly OwnedLabel[], ages: PolicyAges): string[] {
  const isFlagged = labels.includes('missing-issue') || labels.includes('unapproved-issue');
  return [
    ...(isFlagged
      ? [
          `This pull request is closed ${ages.flagNoticeDays} days after it was flagged, unless it links an approved issue before that.`,
        ]
      : []),
    ...(labels.includes('stale')
      ? [
          `This pull request is closed ${ages.idleNoticeDays} days after it was labelled \`stale\`, unless someone comments or pushes before that.`,
        ]
      : []),
  ];
}

// A comment that closes the pull request says so first and warns of
// nothing, because the notice period that it would warn of has passed.
function commentBody(
  pr: PullRequest,
  verdict: Verdict,
  labels: readonly OwnedLabel[],
  ages: PolicyAges,
): string {
  const reasons = supportingFacts(verdict, OutputName.Comment).map(
    (fact) => `- ${verdict.details(fact) ?? verdict.summary(fact)!}`,
  );
  // GraphQL returns the login of a bot without `[bot]`, so a mention of it
  // would reach whichever account has that name.
  const mention = pr.author && pr.author.typename !== 'Bot' ? `@${pr.author.login}, this` : 'This';
  const lines = verdict.outputsThatHold.includes(OutputName.Close)
    ? [
        `${mention} ${CLOSING_SENTENCE}`,
        '',
        ...reasons,
        '',
        'It can be reopened once that has changed.',
      ]
    : [
        `${mention} pull request needs attention.`,
        '',
        ...reasons,
        '',
        // No notice period runs for a pull request that is never closed.
        ...(doNotExpirePredicate(pr) ? [] : deadlines(labels, ages)),
      ];
  return [LIFECYCLE_COMMENT_MARKER, ...lines].join('\n').trimEnd();
}

// `ages` are the ages that the verdict was decided with, for the deadlines
// that the comment states.
export function planOf(pr: PullRequest, verdict: Verdict, ages: PolicyAges): Plan {
  const holds = (name: OutputName): boolean => verdict.outputsThatHold.includes(name);
  const labels = OWNED_LABELS.filter((label) => holds(labelOutputName(label)));
  const reasons: Record<string, string[]> = {};
  for (const name of [...labels.map(labelOutputName), OutputName.Close].filter(holds)) {
    reasons[name] = verdict.reasons({ kind: 'output', name });
  }
  return {
    labels,
    comment: holds(OutputName.Comment) ? commentBody(pr, verdict, labels, ages) : null,
    shouldClose: holds(OutputName.Close),
    reasons,
  };
}
