import {
  type CheckConclusion,
  type CheckId,
  checkRunConclusion,
  type Verdict,
} from '@jaegertracing/maintainer-tools-checks';

export interface NewCheckRun {
  name: string;
  conclusion: CheckConclusion;
  output: { title: string; summary: string; text: string };
}

// The check run that the action publishes for a check, or undefined when the
// check has no check run or does not apply to the pull request of the verdict.
export function newCheckRun(id: CheckId, verdict: Verdict): NewCheckRun | undefined {
  const conclusion = checkRunConclusion(id, verdict);
  if (conclusion === undefined) return undefined;
  const summary = verdict.summary(id)!;
  return {
    name: `maintainer-tools: ${id}`,
    conclusion,
    output: {
      title: summary,
      summary,
      text: verdict.details(id) ?? '',
    },
  };
}
