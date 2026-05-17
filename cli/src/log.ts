// Centralized stderr logger. Every line is timestamped so the user can tell
// instantly whether the CLI is making progress or hung. Goes to stderr so
// the `--output` stdout path stays clean for piping the report.

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}
