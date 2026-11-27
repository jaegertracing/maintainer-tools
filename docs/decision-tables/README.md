# Decision tables

A decision table shows, for one output of the policy, which values of the base facts make the output hold. The policy is the set of facts and rules in [`packages/checks/src/policy.ts`](../../packages/checks/src/policy.ts). "Predicate model" in [`ARCHITECTURE.md`](../../ARCHITECTURE.md) defines the two outputs, `triage_hidden` and `weekly_digest`.

The tables are generated from the rules, and no tool reads them. They exist for two readers:

- **A reviewer of a policy change.** A rule can read a derived fact, and a veto can cancel a reason, so the effect of an edited rule is not always visible in the edit. The pull request that changes a rule also changes the table, and the diff of the table shows each combination of base facts for which the output changed.
- **A maintainer who asks why a pull request is hidden or listed.** The row that matches the base facts of the pull request says whether the output holds, and it names a reason.

## Reading a table

The first columns are the base facts that can change the output. The next column is the output. A row stands for every combination of base facts that matches it: `yes` and `no` fix the value of a base fact, and a dash marks a base fact that does not change the output in that row.

The last two columns name the reasons and the vetoes that hold when every base fact with a dash is false. A base fact with a dash that is true can add a reason, but it does not change the output. Below the table are the rules of each derived fact that those columns name.

## Updating the tables

The test `packages/checks/src/decision-tables.test.ts` generates the tables and fails when a committed table differs. After a change of the rules, run this in `packages/checks` and commit the result:

```
pnpm run decision-tables
```
