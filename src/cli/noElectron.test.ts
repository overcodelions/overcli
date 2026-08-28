// The CLI must not be able to reach `electron`.
//
// Packaged, `overcli` runs under plain node, where `require('electron')`
// resolves to a stub that returns the path to a binary — or throws. Either
// way, a single stray import anywhere in the transitive graph takes down every
// command, and it would do so at REQUIRE time, before any of our error
// handling runs. That failure is also invisible in development, where the
// electron package is right there in node_modules and imports fine.
//
// So this walks the graph statically rather than importing it. Importing would
// execute module bodies — installing hosts, opening stores — and would only
// catch an electron import on a path that happens to be evaluated. Reading the
// files catches every one.
//
// A STATIC import is the thing being banned. A lazy `require('electron')`
// inside a try/catch is a different animal and is allowed: it is how
// `health.ts` asks "am I packaged?" without making itself unimportable, and
// under plain node it either yields the electron package's path export (so the
// destructured `app` is undefined) or throws into the catch. Banning it too
// would force a pointless indirection; leaving it unchecked would let someone
// add an unguarded one. So both are asserted, differently.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

/// Specifiers reached by a static `import`/`export … from`, which is what
/// executes at module load.
function staticSpecifiersIn(body: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(body))) out.push(m[1]);
  return out;
}

/// Specifiers reached by `require(...)`, which executes only when the
/// enclosing function is called.
function lazySpecifiersIn(body: string): Array<{ spec: string; index: number }> {
  const out: Array<{ spec: string; index: number }> = [];
  REQUIRE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REQUIRE_RE.exec(body))) out.push({ spec: m[1], index: m.index });
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/// Every file reachable from `entry` by relative import, plus the bare
/// specifiers each one pulls in.
interface Graph {
  files: Set<string>;
  /// bare specifier -> files that import it statically
  staticBare: Map<string, string[]>;
  /// `require('x')` sites, with enough context to check they are guarded
  lazy: Array<{ spec: string; file: string; guarded: boolean }>;
}

function walk(entry: string): Graph {
  const files = new Set<string>();
  const staticBare = new Map<string, string[]>();
  const lazy: Graph['lazy'] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const body = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(ROOT, file);

    for (const spec of staticSpecifiersIn(body)) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
        continue;
      }
      if (spec.startsWith('.')) continue; // relative but unresolvable — a .json or a type-only path
      staticBare.set(spec, [...(staticBare.get(spec) ?? []), rel]);
    }

    for (const { spec, index } of lazySpecifiersIn(body)) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
        continue;
      }
      if (spec.startsWith('.')) continue;
      // "Guarded" = a `try {` opens in the preceding few lines. Crude, but it
      // is checking a convention, not parsing the language, and the failure
      // mode is a false alarm on an unusual layout rather than a miss.
      const before = body.slice(Math.max(0, index - 400), index);
      lazy.push({ spec, file: rel, guarded: /try\s*\{/.test(before) });
    }
  }
  return { files, staticBare, lazy };
}

describe('the CLI import graph', () => {
  const graph = walk(ENTRY);

  it('never statically imports electron', () => {
    const offenders = graph.staticBare.get('electron') ?? [];
    expect(
      offenders,
      `These files are reachable from src/cli/index.ts and import electron at module load:\n  ${offenders.join('\n  ')}\n` +
        'The CLI runs under plain node. Move whatever needs electron behind the HostEnv seam (src/main/host.ts).',
    ).toEqual([]);
  });

  it('only reaches electron lazily, from inside a try', () => {
    const unguarded = graph.lazy.filter((l) => l.spec === 'electron' && !l.guarded);
    expect(
      unguarded.map((l) => l.file),
      'A lazy require of electron on the CLI path must sit inside a try/catch — under plain node it ' +
        'either resolves to the package\'s path export or throws, and an unguarded one crashes the command.',
    ).toEqual([]);
  });

  it('reaches the real engines, so the guard above is actually guarding something', () => {
    const rel = [...graph.files].map((f) => path.relative(ROOT, f));
    // If a refactor ever stubs these out, the electron assertion becomes
    // vacuously true — this is the canary for that.
    expect(rel).toContain('src/main/runner.ts');
    expect(rel).toContain('src/main/flows/runtime.ts');
    expect(rel).toContain('src/main/flows/workerEngine.ts');
    expect(rel).toContain('src/main/store.ts');
  });

  it('does not pull in the renderer', () => {
    const renderer = [...graph.files]
      .map((f) => path.relative(ROOT, f))
      .filter((f) => f.startsWith('src/renderer/'));
    expect(renderer).toEqual([]);
  });
});
