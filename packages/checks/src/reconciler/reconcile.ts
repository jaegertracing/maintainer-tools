// The deciding half of a run of the reconciler: the plan of every open pull
// request and the changes that bring each one to its plan. It makes no
// GitHub call and reads no clock, so its result depends only on its
// arguments.

import { ruleSet } from '../policy.js';
import type { OpenPullRequests, PolicyAges, PullRequest } from '../types.js';
import { changesOf } from './difference.js';
import type { Change } from './difference.js';
import { planOf } from './plan.js';
import type { Plan } from './plan.js';

export interface Reconciliation {
  pr: PullRequest;
  plan: Plan;
  changes: Change[];
}

export function reconcile(
  openPullRequests: OpenPullRequests,
  now: Date,
  ages: PolicyAges,
): Reconciliation[] {
  return openPullRequests.pullRequests.map((pr) => {
    const plan = planOf(pr, ruleSet.evaluate(pr, { now, openPullRequests, ages }), ages);
    return { pr, plan, changes: changesOf(pr, plan) };
  });
}
