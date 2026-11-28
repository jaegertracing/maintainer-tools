// The entry point of the bundle of the `lifecycle-reconciler` action: the
// `reconcile` command alone, so that the bundle leaves out what the other
// commands of the CLI depend on.

import { runReconcile } from '../../cli/src/reconcile.js';

runReconcile(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
