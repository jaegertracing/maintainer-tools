// The decision tables in `packages/checks/decision-tables/` show a reviewer
// which base facts lead to each output. No tool reads the tables, so their
// generator is in this test and not in the package. The test writes the
// tables when `UPDATE_DECISION_TABLES` is set, as `pnpm run decision-tables`
// does.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ruleSet as checksRuleSet } from './policy.js';
import type { RuleSet } from './rules/evaluate.js';
import { isSameConclusion, OutputName, premiseText, ruleText } from './rules/model.js';
import type { Conclusion, Rule } from './rules/model.js';
import { allPossibleBaseFacts, baseFactsAffecting } from './rules/startup-check.js';

const DECISION_TABLES_DIRECTORY = fileURLToPath(new URL('../decision-tables/', import.meta.url));

// A "merged row" is one row of a decision table. It stands for a set of
// combinations of base-fact values, and it is written with one character for
// each base fact: `1` and `0` fix the value of the base fact, and `-` leaves
// it free.
type MergedRow = string;

function withBaseFactValue(mergedRow: MergedRow, index: number, value: '1' | '0'): MergedRow {
  return mergedRow.slice(0, index) + value + mergedRow.slice(index + 1);
}

function freeBaseFactIndices(mergedRow: MergedRow): number[] {
  return [...mergedRow].flatMap((character, index) => (character === '-' ? [index] : []));
}

// `mergedRows()` returns merged rows that together cover every combination,
// and the output has one value within each. It splits a merged row in which
// the output has both values on one base fact, choosing the base fact that
// gives the fewest merged rows.
function mergedRows(
  baseFactCount: number,
  holdsByCombination: Map<MergedRow, boolean>,
): MergedRow[] {
  const valueByMergedRow = new Map<MergedRow, boolean | undefined>();
  const outputValueIn = (mergedRow: MergedRow): boolean | undefined => {
    const index = mergedRow.indexOf('-');
    if (index < 0) return holdsByCombination.get(mergedRow);
    if (!valueByMergedRow.has(mergedRow)) {
      const whenTrue = outputValueIn(withBaseFactValue(mergedRow, index, '1'));
      const whenFalse = outputValueIn(withBaseFactValue(mergedRow, index, '0'));
      valueByMergedRow.set(mergedRow, whenTrue === whenFalse ? whenTrue : undefined);
    }
    return valueByMergedRow.get(mergedRow);
  };
  const splitByMergedRow = new Map<MergedRow, { count: number; index: number }>();
  const mergedRowCountOf = (mergedRow: MergedRow): number => {
    if (outputValueIn(mergedRow) !== undefined) return 1;
    if (!splitByMergedRow.has(mergedRow)) {
      let bestSplit = { count: Infinity, index: -1 };
      for (const index of freeBaseFactIndices(mergedRow)) {
        const count =
          mergedRowCountOf(withBaseFactValue(mergedRow, index, '1')) +
          mergedRowCountOf(withBaseFactValue(mergedRow, index, '0'));
        if (count < bestSplit.count) bestSplit = { count, index };
      }
      splitByMergedRow.set(mergedRow, bestSplit);
    }
    return splitByMergedRow.get(mergedRow)!.count;
  };
  const mergedRowsOf = (mergedRow: MergedRow): MergedRow[] => {
    if (mergedRowCountOf(mergedRow) === 1) return [mergedRow];
    const { index } = splitByMergedRow.get(mergedRow)!;
    return [
      ...mergedRowsOf(withBaseFactValue(mergedRow, index, '1')),
      ...mergedRowsOf(withBaseFactValue(mergedRow, index, '0')),
    ];
  };
  return mergedRowsOf('-'.repeat(baseFactCount));
}

// Returns the rules of the derived facts among `facts`, and of the derived
// facts that those rules read.
function rulesOfDerivedFacts(ruleSet: RuleSet, facts: readonly string[]): Rule[] {
  const rulesForDerivedFacts = ruleSet.rules.filter(
    (rule) => rule.conclusion.kind === 'derived fact',
  );
  const derivedFacts = new Set<string>();
  const visitFact = (fact: string): void => {
    const rules = rulesForDerivedFacts.filter((rule) => rule.conclusion.name === fact);
    if (rules.length === 0 || derivedFacts.has(fact)) return;
    derivedFacts.add(fact);
    for (const rule of rules) rule.premises.forEach(visitFact);
  };
  facts.forEach(visitFact);
  return rulesForDerivedFacts.filter((rule) => derivedFacts.has(rule.conclusion.name));
}

function decisionTable(ruleSet: RuleSet, output: OutputName): string {
  const conclusion: Conclusion = { kind: 'output', name: output };
  const baseFactNames = baseFactsAffecting(ruleSet.rules, conclusion);
  const combinations = allPossibleBaseFacts(baseFactNames);
  const verdicts = ruleSet.evaluateBaseFacts(combinations);
  const combinationKeys = combinations.map((baseFacts) =>
    baseFactNames.map((name) => (baseFacts[name] ? '1' : '0')).join(''),
  );
  const verdictByCombination = new Map(
    combinationKeys.map((combinationKey, index) => [combinationKey, verdicts[index]!]),
  );
  const holdsByCombination = new Map(
    combinationKeys.map((combinationKey, index) => [
      combinationKey,
      verdicts[index]!.outputsThatHold.includes(output),
    ]),
  );
  const cellOf = { '1': 'yes', '0': 'no', '-': '-' } as Record<string, string>;
  const premiseTextsInTable = new Set<string>();
  const tableLines = mergedRows(baseFactNames.length, holdsByCombination).map((mergedRow) => {
    const verdict = verdictByCombination.get(mergedRow.replaceAll('-', '0'))!;
    const reasons = verdict.reasons(conclusion);
    const vetoes = verdict.vetoes(conclusion);
    for (const text of [...reasons, ...vetoes]) premiseTextsInTable.add(text);
    const cells = [
      ...[...mergedRow].map((character) => cellOf[character]),
      verdict.outputsThatHold.includes(output) ? '**yes**' : 'no',
      reasons.join('<br>'),
      vetoes.join('<br>'),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  const derivedFactRules = rulesOfDerivedFacts(
    ruleSet,
    ruleSet.rules
      .filter(
        (rule) =>
          isSameConclusion(rule.conclusion, conclusion) &&
          premiseTextsInTable.has(premiseText(rule)),
      )
      .flatMap((rule) => rule.premises),
  );
  return [
    `# Decision table of \`${output}\``,
    '',
    `Generated from the rules by \`pnpm run decision-tables\`. Each column but the last three is a base fact. A dash marks a base fact that does not change whether \`${output}\` holds in the row. The last two columns name the reasons and the vetoes for \`${output}\` that hold in the row when every base fact with a dash is false. A row without a reason is a combination about which the rules say nothing.`,
    '',
    `| ${[...baseFactNames, `\`${output}\``, 'reasons that held', 'vetoes that held'].join(' | ')} |`,
    `|${' --- |'.repeat(baseFactNames.length + 3)}`,
    ...tableLines,
    '',
    ...(derivedFactRules.length > 0
      ? [
          'A derived fact that the last two columns name is decided by the rules below. The fact holds when one of its reasons, written `… ⇒ fact`, holds and none of its vetoes, written `… ⇒ not fact`, does.',
          '',
          ...derivedFactRules.map((rule) => `- \`${ruleText(rule)}\``),
          '',
        ]
      : []),
  ].join('\n');
}

// One table for each output that has a rule, by file name.
function decisionTables(ruleSet: RuleSet): Map<string, string> {
  const outputs = Object.values(OutputName).filter((output) =>
    ruleSet.rules.some((rule) =>
      isSameConclusion(rule.conclusion, { kind: 'output', name: output }),
    ),
  );
  return new Map(outputs.map((output) => [`${output}.md`, decisionTable(ruleSet, output)]));
}

test('the committed decision tables are the ones that the rules generate', () => {
  const generatedTables = decisionTables(checksRuleSet);
  if (process.env.UPDATE_DECISION_TABLES) {
    for (const [file, table] of generatedTables) {
      writeFileSync(DECISION_TABLES_DIRECTORY + file, table);
    }
  }
  const committedTables = new Map(
    readdirSync(DECISION_TABLES_DIRECTORY)
      .sort()
      .map((file) => [file, readFileSync(DECISION_TABLES_DIRECTORY + file, 'utf8')]),
  );
  assert.deepEqual(committedTables, new Map([...generatedTables].sort()));
});
