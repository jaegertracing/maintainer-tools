import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PrCache } from '@jaegertracing/maintainer-tools-checks/cache';

import { log } from './log.js';

export async function openCacheIfEnabled(path: string, disabled: boolean): Promise<PrCache | null> {
  if (disabled) return null;
  try {
    const cacheMod = await import('@jaegertracing/maintainer-tools-checks/cache');
    mkdirSync(dirname(path), { recursive: true });
    return cacheMod.openCache(path);
  } catch (err) {
    // `node:sqlite` is built into Node 22.5+, so the realistic failure modes
    // here are (a) running on an older Node where the module isn't available,
    // or (b) a filesystem error opening the cache file (perms, full disk,
    // path unwritable). Either way, fall back to cacheless rather than
    // crashing; the triage still works, just pays full GraphQL cost.
    log(`warning: cache disabled (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}
