// Guard against re-introducing the uncontained-spawn crash.
//
// Any module that calls `spawn(...)` on a long-lived child MUST also register
// an 'error' listener on it. Without one, a spawn failure (binary missing, bad
// PATH, no execute permission, cwd deleted) is rethrown by Node as an uncaught
// exception. `index.ts` installs an `uncaughtException` handler only under
// `isDev`, so in a packaged build that takes down the whole Electron main
// process — every conversation, flow run and worker shift at once.
//
// This exact defect shipped in geminiAcp.ts and codex-app-server.ts and was
// fixed more than once, so the rule is now enforced rather than remembered.
//
// Deliberately coarse: it greps for the two markers per file rather than
// parsing. That is enough to catch "someone added a new spawning client and
// forgot the listener", which is the failure mode that actually happened.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_DIR = join(__dirname);

/// Files that call spawn() but legitimately need no 'error' listener, each
/// with the reason. Keep this list short and justified.
const EXEMPT = new Set<string>([
  // Uses spawnSync only (synchronous; failures come back as a result object
  // with an `error` field rather than an emitted event).
  'backendPaths.ts',
]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/// True when the file starts a long-lived child via async spawn(). Ignores
/// `spawnSync(` — the trailing char check keeps `spawnSync` from matching.
function spawnsAsync(src: string): boolean {
  return /[^a-zA-Z]spawn\(/.test(src);
}

function hasErrorListener(src: string): boolean {
  return /\.on\(\s*['"]error['"]/.test(src);
}

describe('every async spawn() site registers an error listener', () => {
  it('has no unguarded spawn under src/main', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(MAIN_DIR)) {
      const name = file.slice(MAIN_DIR.length + 1);
      if (EXEMPT.has(name)) continue;
      const src = readFileSync(file, 'utf-8');
      if (spawnsAsync(src) && !hasErrorListener(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('actually inspects a meaningful number of files (guards against a vacuous pass)', () => {
    const spawning = tsFilesUnder(MAIN_DIR).filter((f) => spawnsAsync(readFileSync(f, 'utf-8')));
    // If this ever drops to zero the detector broke, and the test above would
    // pass while checking nothing.
    expect(spawning.length).toBeGreaterThan(5);
  });
});
