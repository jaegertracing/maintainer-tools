import type { CheckResult, PullRequest } from '../types.js';

// Source-code file extensions we care about. Limited to the languages
// the Jaeger org actually ships; expand as the org takes on more.
const CODE_EXTENSIONS = new Set(['go', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'java', 'rb']);

// Per-language test-file detection. Either the file name matches a
// language test convention, or the path crosses a known test directory.
function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (
    lower.endsWith('_test.go') ||
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(lower) ||
    /^test_.*\.py$/.test(lower.split('/').pop() ?? '') ||
    /_test\.py$/.test(lower) ||
    /_test\.rs$/.test(lower) ||
    /test\.java$/.test(lower)
  ) {
    return true;
  }
  // Match path segments rather than substrings so `tests/foo.go` (no
  // leading slash, at the repo root) and `pkg/tests/foo.go` are both
  // recognised.
  const segments = lower.split('/');
  return (
    segments.includes('test') ||
    segments.includes('tests') ||
    segments.includes('__tests__') ||
    segments.includes('spec')
  );
}

function isCodeFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext !== undefined && CODE_EXTENSIONS.has(ext);
}

// Same exemption list as `no_linked_issue` — doc/CI/trivial PRs don't
// need tests.
const EXEMPT_LABELS = new Set(['docs', 'documentation', 'ci', 'trivial', 'chore']);

export function noTestsForCodeChange(pr: PullRequest): CheckResult {
  if (pr.labels.some((l) => EXEMPT_LABELS.has(l.toLowerCase()))) {
    return mk(false, 'Test-coverage check skipped (PR labelled docs/ci/trivial)');
  }
  const codeFiles = pr.files.filter(isCodeFile).filter((f) => !isTestFile(f));
  if (codeFiles.length === 0) {
    return mk(false, 'No source files changed');
  }
  const touchedTests = pr.files.some(isTestFile);
  const triggered = !touchedTests;
  return mk(
    triggered,
    triggered
      ? `${codeFiles.length} source file(s) changed but no tests were added or modified`
      : 'Tests were added or modified alongside the source changes',
    triggered
      ? 'Add or update tests covering the change. If the change genuinely doesn’t need tests (refactor, dep bump, etc.), apply a `trivial` or `chore` label to skip this check.'
      : undefined,
  );
}

function mk(triggered: boolean, summary: string, details?: string): CheckResult {
  return {
    id: 'no_tests_for_code_change',
    triggered,
    summary,
    details,
    publishesCheck: true,
    checkConclusion: triggered ? 'neutral' : 'success',
    inDigest: triggered,
    hidesFromTriage: false,
  };
}
