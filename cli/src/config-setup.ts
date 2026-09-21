// First-run config setup: when no config is found and stdin is a terminal,
// offers to copy a sample config into place instead of only reporting where
// the CLI looked.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG_PATHS,
  findExistingConfigPath,
  HOME_CONFIG_PATH,
  loadConfig,
  type TriageConfig,
} from './config.js';

const SAMPLE_CONFIGS = {
  generic: fileURLToPath(new URL('../config.example.json', import.meta.url)),
  jaeger: fileURLToPath(new URL('../config.example.jaeger.json', import.meta.url)),
};

export function copySampleConfig(
  kind: keyof typeof SAMPLE_CONFIGS,
  targetPath: string = HOME_CONFIG_PATH,
): string {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(SAMPLE_CONFIGS[kind], targetPath);
  return targetPath;
}

// Returns true if a config was created — the caller should tell the user to
// edit it and rerun rather than continuing this run. Returns false (without
// prompting) when stdin isn't a terminal, or when the user declines, so the
// caller falls through to loadConfig's own "no config found" error.
async function promptToCreateConfig(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(
      `No config found. Looked at:\n  ${DEFAULT_CONFIG_PATHS.join('\n  ')}\n\n` +
        'Create one now?\n  1) Generic starter config\n  2) Jaeger org config\n  Q) Exit\n> ',
    );
  } finally {
    rl.close();
  }

  const kind = answer.trim() === '1' ? 'generic' : answer.trim() === '2' ? 'jaeger' : undefined;
  if (!kind) return false;

  const path = copySampleConfig(kind);
  process.stdout.write(`\nWrote ${path}. Edit it — especially "repos" — then rerun.\n`);
  return true;
}

export async function loadConfigInteractive(explicitPath?: string): Promise<TriageConfig> {
  if (!explicitPath && !findExistingConfigPath() && (await promptToCreateConfig())) {
    process.exit(1);
  }
  return loadConfig(explicitPath);
}
