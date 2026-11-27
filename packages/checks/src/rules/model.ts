// This file declares the concepts of the rule form. "Vocabulary of the rule
// form" in ARCHITECTURE.md defines each term.

import type { PullRequest, PredicateContext } from '../types.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// An output is a decision that the rules make about a pull request and that
// one tool acts on. The rules decide, for each pull request, whether each
// output holds. This enum names the outputs, and each member says what its
// tool does with a pull request that the output holds for.
export enum OutputName {
  // The triage CLI leaves the pull request out of the buckets that ask for a
  // maintainer's attention and lists it in the Hidden bucket of the report.
  TriageHidden = 'triage_hidden',
  // The `pr-weekly-digest` action, which reminds the author of a quiet pull
  // request with a comment, has something to list in that comment.
  WeeklyDigest = 'weekly_digest',
  // The reconciler keeps the label on the pull request while the output
  // holds, and removes it otherwise.
  LabelMissingIssue = 'label:missing-issue',
  LabelUnapprovedIssue = 'label:unapproved-issue',
  LabelStale = 'label:stale',
  LabelDuplicate = 'label:duplicate',
  LabelPrQuotaReached = 'label:pr-quota-reached',
  LabelWaitingForAuthor = 'label:waiting-for-author',
  // The reconciler keeps one comment on the pull request that tells the
  // author why the pull request needs attention.
  Comment = 'comment',
  // The reconciler closes the pull request.
  Close = 'close',
}

// The labels that the reconciler owns: it adds and removes them, and no
// person and no other tool does.
export const OWNED_LABELS = [
  'missing-issue',
  'unapproved-issue',
  'stale',
  'duplicate',
  'pr-quota-reached',
  'waiting-for-author',
] as const;
export type OwnedLabel = (typeof OWNED_LABELS)[number];

const LABEL_OUTPUT_NAMES: Record<OwnedLabel, OutputName> = {
  'missing-issue': OutputName.LabelMissingIssue,
  'unapproved-issue': OutputName.LabelUnapprovedIssue,
  stale: OutputName.LabelStale,
  duplicate: OutputName.LabelDuplicate,
  'pr-quota-reached': OutputName.LabelPrQuotaReached,
  'waiting-for-author': OutputName.LabelWaitingForAuthor,
};

export function labelOutputName(label: OwnedLabel): OutputName {
  return LABEL_OUTPUT_NAMES[label];
}

// The outputs that the reconciler applies to a pull request, which together
// are the plan of the pull request.
export const RECONCILER_OUTPUT_NAMES: readonly OutputName[] = [
  ...OWNED_LABELS.map(labelOutputName),
  OutputName.Comment,
  OutputName.Close,
];

// A conclusion is the derived fact or the output that a rule decides. It
// carries its kind because a fact and an output may have the same name.
export type Conclusion =
  | { readonly kind: 'derived fact'; readonly name: string }
  | { readonly kind: 'output'; readonly name: OutputName };

export function isSameConclusion(left: Conclusion, right: Conclusion): boolean {
  return left.kind === right.kind && left.name === right.name;
}

// A rule is one `.when()` or `.unless()` call, recorded as data. It names a
// list of facts, which are its premises, and one derived fact or output,
// which is its conclusion. A rule that `.when()` records is a reason: "if
// all of the premises hold, the conclusion holds". A rule that `.unless()`
// records is a veto: "if all of the premises hold, the conclusion does not
// hold". For example,
//
//   hidden.when(draft).when(stale, noReview).unless(pinned)
//
// records three rules with the conclusion `hidden`:
//
//   premises: draft             a reason
//   premises: stale, noReview   a reason
//   premises: pinned            a veto
//
// A rule holds when all of its premises hold. No single rule decides its
// conclusion. The evaluator reads all the rules of one conclusion, and the
// conclusion holds when at least one of its reasons holds and none of its
// vetoes does. A rule holds no result of an evaluation; a `Verdict` does.
export interface Rule {
  readonly conclusion: Conclusion;
  // The names of the facts that the rule reads.
  readonly premises: readonly string[];
  // True when the rule is a veto, and false when it is a reason.
  readonly isVeto: boolean;
}

// A predicate is the function that reads a pull request and returns whether
// one base fact holds, with an optional summary. Everything else that a
// policy holds is data. A predicate must be a pure function of the pull
// request and the predicate context, which holds the clock and, when the
// consumer gathers them, the open pull requests of the run. The startup
// check evaluates the rules without calling a predicate, and a verdict must
// be reproducible from those two arguments.
export type Predicate = (pr: PullRequest, context: PredicateContext) => BaseFactValue;

// The value of a base fact for one pull request. A predicate returns the
// object form when its base fact has a summary for a consumer to print.
export type BaseFactValue =
  | boolean
  | {
      holds: boolean;
      // Short text for the state of the pull request, whether the fact holds
      // or not.
      summary: string;
      // A paragraph that tells the author how to make the fact stop holding.
      details?: string;
    };

// The change source of a base fact is who can change its value: the author,
// a maintainer, or time. The startup check uses it to find an output that no
// person can clear.
export type ChangeSource = 'author' | 'maintainer' | 'time';

export type Fact = BaseFact | DerivedFact;

function namesOf(facts: readonly Fact[]): string[] {
  return facts.map((fact) => fact.name);
}

// A base fact is a named boolean of one pull request whose value comes from
// a predicate. It holds when its predicate returns true.
export class BaseFact {
  constructor(
    readonly name: string,
    readonly predicate: Predicate,
    readonly changedBy: ChangeSource,
    // The label outputs whose age the fact measures. A fact with such
    // outputs is a "label age": it can hold only while the pull request
    // carries one of the labels. Every other base fact has none.
    readonly ageOf: readonly OutputName[] = [],
  ) {}
}

// The start of the current unbroken period in which a pull request carries
// one of `labels`, or undefined when it carries none or when no event dates
// the period. A swap from one label to another adds before it removes, so
// the period stays unbroken while one of the labels is present. The events
// are undone from the newest one, because only the newest events are
// gathered and the labels before the oldest of them are unknown.
export function labelPeriodStart(pr: PullRequest, labels: readonly string[]): string | undefined {
  const presentLabels = new Set(pr.labels.filter((label) => labels.includes(label)));
  if (presentLabels.size === 0) return undefined;
  const eventsNewestFirst = (pr.labelEvents ?? [])
    .filter((event) => labels.includes(event.label))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .reverse();
  for (const event of eventsNewestFirst) {
    if (event.event === 'unlabeled') {
      presentLabels.add(event.label);
    } else {
      presentLabels.delete(event.label);
      if (presentLabels.size === 0) return event.at;
    }
  }
  return undefined;
}

// A derived fact is a named boolean of one pull request that rules decide
// from other facts. `.when(a, b)` declares a reason with the premises `a` and
// `b`, and `.unless(a)` declares a veto.
export class DerivedFact {
  // Appends a rule to the list of the policy that created this object. It is
  // a function of the policy and not the policy itself, so that the policy
  // needs no public method that records a rule.
  readonly #recordRule: (rule: Rule) => void;

  constructor(
    readonly name: string,
    recordRule: (rule: Rule) => void,
  ) {
    this.#recordRule = recordRule;
  }

  when(first: Fact, ...rest: Fact[]): this {
    this.#recordRule({
      conclusion: { kind: 'derived fact', name: this.name },
      premises: namesOf([first, ...rest]),
      isVeto: false,
    });
    return this;
  }

  unless(first: Fact, ...rest: Fact[]): this {
    this.#recordRule({
      conclusion: { kind: 'derived fact', name: this.name },
      premises: namesOf([first, ...rest]),
      isVeto: true,
    });
    return this;
  }
}

// An output is a decision that the rules make about a pull request and that
// one tool acts on, such as hiding the pull request in the triage report.
// Rules decide an output as they decide a derived fact. No rule reads an
// output, because `.when()` and `.unless()` accept facts only.
export class Output {
  // Appends a rule to the list of the policy that created this object. It is
  // a function of the policy and not the policy itself, so that the policy
  // needs no public method that records a rule.
  readonly #recordRule: (rule: Rule) => void;

  constructor(
    readonly name: OutputName,
    recordRule: (rule: Rule) => void,
  ) {
    this.#recordRule = recordRule;
  }

  when(first: Fact, ...rest: Fact[]): this {
    this.#recordRule({
      conclusion: { kind: 'output', name: this.name },
      premises: namesOf([first, ...rest]),
      isVeto: false,
    });
    return this;
  }

  unless(first: Fact, ...rest: Fact[]): this {
    this.#recordRule({
      conclusion: { kind: 'output', name: this.name },
      premises: namesOf([first, ...rest]),
      isVeto: true,
    });
    return this;
  }
}

// A policy is the container of the base facts, the derived facts, the
// outputs and the rules. It is a Datalog program without recursion. Its methods record data
// and evaluate nothing, so the evaluator, the startup check and any other
// program can read the whole policy from `rules` and `baseFacts`.
export class Policy {
  readonly #declaredRules: Rule[] = [];
  readonly #declaredBaseFacts: BaseFact[] = [];
  readonly #factNames = new Set<string>();

  // Appends a rule to the list of this policy. Only a derived fact and an
  // output have `.when()` and `.unless()`, and this function is private to
  // the policy, which passes it only to them. A
  // rule therefore cannot decide a base fact or have a conclusion that the
  // policy does not declare.
  readonly #recordRule = (rule: Rule): void => {
    this.#declaredRules.push(rule);
  };

  readonly triageHidden = new Output(OutputName.TriageHidden, this.#recordRule);
  readonly weeklyDigest = new Output(OutputName.WeeklyDigest, this.#recordRule);
  readonly comment = new Output(OutputName.Comment, this.#recordRule);
  readonly close = new Output(OutputName.Close, this.#recordRule);
  readonly #labels = new Map<OwnedLabel, Output>();
  readonly #declaredExclusions: (readonly [OutputName, OutputName])[] = [];

  get rules(): readonly Rule[] {
    return this.#declaredRules;
  }

  get exclusions(): readonly (readonly [OutputName, OutputName])[] {
    return this.#declaredExclusions;
  }

  // The output that holds while the pull request should carry `label`.
  label(label: OwnedLabel): Output {
    const declared = this.#labels.get(label);
    if (declared) return declared;
    const output = new Output(labelOutputName(label), this.#recordRule);
    this.#labels.set(label, output);
    return output;
  }

  // A label age: a base fact that holds when the pull request has carried
  // one of the labels of `of`, without a break, for at least `days`. The
  // number of days is a setting of the run, so `days` reads it from the
  // context. It is how a rule reads the age of a label that the reconciler
  // applied, and the startup check limits it to the notice form.
  labelAge(
    name: string,
    { of, days }: { of: readonly Output[]; days: (context: PredicateContext) => number },
  ): BaseFact {
    const outputNames = of.map((output) => output.name);
    const labels = OWNED_LABELS.filter((label) => outputNames.includes(labelOutputName(label)));
    if (labels.length === 0 || labels.length !== of.length) {
      throw new Error(`the label age ${name} measures an output that is not a label`);
    }
    this.addFactName(name);
    const labelAge = new BaseFact(
      name,
      (pr, context) => {
        const periodStart = labelPeriodStart(pr, labels);
        return (
          periodStart !== undefined &&
          context.now.getTime() - Date.parse(periodStart) >= days(context) * MILLISECONDS_PER_DAY
        );
      },
      'time',
      outputNames,
    );
    this.#declaredBaseFacts.push(labelAge);
    return labelAge;
  }

  // Declares that the two outputs never hold for one pull request. The
  // startup check rejects a rule set in which they can.
  exclusive(left: Output, right: Output): void {
    this.#declaredExclusions.push([left.name, right.name]);
  }

  get baseFacts(): readonly BaseFact[] {
    return this.#declaredBaseFacts;
  }

  baseFact(
    name: string,
    predicate: Predicate,
    { changedBy }: { changedBy: ChangeSource },
  ): BaseFact {
    this.addFactName(name);
    const baseFact = new BaseFact(name, predicate, changedBy);
    this.#declaredBaseFacts.push(baseFact);
    return baseFact;
  }

  derivedFact(name: string): DerivedFact {
    this.addFactName(name);
    return new DerivedFact(name, this.#recordRule);
  }

  private addFactName(name: string): void {
    if (this.#factNames.has(name)) {
      throw new Error(`the fact ${name} is declared twice`);
    }
    this.#factNames.add(name);
  }
}

// `Verdict.reasons()` and `Verdict.vetoes()` name a rule by this text. Two
// rules of one conclusion that have the same premises have the same text.
export function premiseText(rule: Rule): string {
  return rule.premises.join(' ∧ ');
}

export function ruleText(rule: Rule): string {
  return `${premiseText(rule)} ⇒ ${rule.isVeto ? 'not ' : ''}${rule.conclusion.name}`;
}
