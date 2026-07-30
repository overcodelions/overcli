import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildLookupArgs,
  declarationPatterns,
  isSafeSymbol,
  lookupModelLadder,
  parseGrepMatches,
  parseModelCandidates,
  siblingExtensions,
  readLineAt,
  verifyCandidate,
} from './symbolLookup';

describe('isSafeSymbol', () => {
  it('accepts identifiers', () => {
    for (const s of ['foo', 'getUser', '_private', '$el', 'A1_b$']) {
      expect(isSafeSymbol(s)).toBe(true);
    }
  });

  it('rejects anything that could reach a regex or a CLI as syntax', () => {
    // Regex metacharacters would corrupt the patterns we build; a leading
    // dash would reach ripgrep as a flag (the option-injection class).
    for (const s of ['', 'foo.bar', 'foo(', 'a|b', '.*', '-n', '--model', 'a b', 'a\nb']) {
      expect(isSafeSymbol(s)).toBe(false);
    }
  });

  it('rejects absurdly long input', () => {
    expect(isSafeSymbol('a'.repeat(200))).toBe(false);
  });
});

describe('declarationPatterns', () => {
  /// The whole value of the grep tier is that it matches *declarations* and
  /// not call sites — a pattern loose enough to hit both makes every lookup
  /// look ambiguous and pay for a model round trip.
  function matchesAny(patterns: string[], line: string): boolean {
    return patterns.some((p) => new RegExp(p).test(line));
  }

  it('matches a Java method declaration but not its call sites', () => {
    const p = declarationPatterns('Service.java', 'doThing');
    expect(matchesAny(p, '  public static Foo doThing(Bar b) {')).toBe(true);
    expect(matchesAny(p, '  private Foo doThing(Bar b) throws IOException {')).toBe(true);
    expect(matchesAny(p, '    svc.doThing(b);')).toBe(false);
    expect(matchesAny(p, '    return doThing(b) + 1;')).toBe(false);
  });

  it('matches Java type declarations', () => {
    const p = declarationPatterns('Service.java', 'FooService');
    expect(matchesAny(p, 'public interface FooService extends Base {')).toBe(true);
    expect(matchesAny(p, 'final class FooService {')).toBe(true);
    expect(matchesAny(p, '  FooService svc = new FooService();')).toBe(false);
  });

  it('matches TS functions, arrows and methods', () => {
    const p = declarationPatterns('a.ts', 'handle');
    expect(matchesAny(p, 'export function handle(req: Req) {')).toBe(true);
    expect(matchesAny(p, 'const handle = async (req) => {')).toBe(true);
    expect(matchesAny(p, '  handle(req: Req): void {')).toBe(true);
    expect(matchesAny(p, '  await handle(req);')).toBe(false);
  });

  it('uses indentation-anchored patterns for Python', () => {
    const p = declarationPatterns('a.py', 'run');
    expect(matchesAny(p, '    def run(self, x):')).toBe(true);
    expect(matchesAny(p, 'async def run():')).toBe(true);
    expect(matchesAny(p, '    self.run(x)')).toBe(false);
  });

  it('handles Ruby singleton methods', () => {
    const p = declarationPatterns('a.rb', 'call');
    expect(matchesAny(p, '  def self.call(x)')).toBe(true);
    expect(matchesAny(p, '  def call(x)')).toBe(true);
    expect(matchesAny(p, '  obj.call(x)')).toBe(false);
  });
});

describe('siblingExtensions', () => {
  it('groups a language family so the grep stays on-language', () => {
    expect(siblingExtensions('/a/B.java')).toEqual(['.java']);
    expect(siblingExtensions('/a/b.tsx')).toContain('.ts');
    expect(siblingExtensions('/a/b.mjs')).toContain('.jsx');
  });

  it('returns no restriction for unknown or extensionless files', () => {
    expect(siblingExtensions('/a/Makefile')).toEqual([]);
    expect(siblingExtensions('/a/b.zzz')).toEqual([]);
  });
});

describe('parseGrepMatches', () => {
  const cwd = path.join(path.sep, 'repo');

  it('parses rg -n output and relativizes absolute paths', () => {
    const out = [
      `${path.join(cwd, 'src', 'A.java')}:12:  public void go() {`,
      'src/B.java:99:  void go() {',
    ].join('\n');
    expect(parseGrepMatches(out, cwd)).toEqual([
      { path: path.join('src', 'A.java'), line: 12 },
      { path: 'src/B.java', line: 99 },
    ]);
  });

  it('drops matches outside the root and malformed lines', () => {
    const out = [
      `${path.join(path.sep, 'elsewhere', 'C.java')}:3:x`,
      'no-line-number-here',
      'src/D.java:0:x',
      '',
    ].join('\n');
    expect(parseGrepMatches(out, cwd)).toEqual([]);
  });
});

describe('parseModelCandidates', () => {
  it('parses the bare contract', () => {
    expect(parseModelCandidates('src/A.java:42\nsrc/B.java:7')).toEqual([
      { path: 'src/A.java', line: 42 },
      { path: 'src/B.java', line: 7 },
    ]);
  });

  it('tolerates fences, bullets and backticks the contract forbade', () => {
    const reply = ['```', '- `src/A.java:42`', '2) src/B.java:7', '```'].join('\n');
    expect(parseModelCandidates(reply)).toEqual([
      { path: 'src/A.java', line: 42 },
      { path: 'src/B.java', line: 7 },
    ]);
  });

  it('returns nothing for NONE or prose', () => {
    expect(parseModelCandidates('NONE')).toEqual([]);
    expect(parseModelCandidates('I could not find the definition anywhere.')).toEqual([]);
  });

  it('dedupes and caps at five', () => {
    const reply = Array.from({ length: 9 }, (_, i) => `src/F${i}.java:${i + 1}`)
      .concat('src/F0.java:1')
      .join('\n');
    const out = parseModelCandidates(reply);
    expect(out).toHaveLength(5);
    expect(new Set(out.map((c) => `${c.path}:${c.line}`)).size).toBe(5);
  });
});

describe('verifyCandidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-symbol-'));
  const file = path.join(root, 'Service.java');
  fs.writeFileSync(file, ['package a;', '', 'public void doThing() {', '}', ''].join('\n'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a line that actually mentions the symbol', async () => {
    const got = await verifyCandidate(root, { path: 'Service.java', line: 3 }, 'doThing', 'grep');
    expect(got).toMatchObject({
      path: 'Service.java',
      absolutePath: file,
      line: 3,
      snippet: 'public void doThing() {',
      source: 'grep',
    });
  });

  it('rejects a line that does not mention the symbol', async () => {
    // This is the check that makes the cheap model tier safe: a plausible
    // but wrong path:line is caught here instead of jumping the user
    // somewhere arbitrary.
    await expect(
      verifyCandidate(root, { path: 'Service.java', line: 1 }, 'doThing', 'model'),
    ).resolves.toBeNull();
  });

  it('requires a whole-word match', async () => {
    // `doThing` must not validate against a hit on `doThingElse`.
    const other = path.join(root, 'Other.java');
    fs.writeFileSync(other, 'void doThingElse() {}\n');
    await expect(
      verifyCandidate(root, { path: 'Other.java', line: 1 }, 'doThing', 'model'),
    ).resolves.toBeNull();
  });

  it('rejects lines past end of file', async () => {
    await expect(
      verifyCandidate(root, { path: 'Service.java', line: 999 }, 'doThing', 'grep'),
    ).resolves.toBeNull();
  });

  it('rejects paths that escape the project root', async () => {
    await expect(
      verifyCandidate(root, { path: '../../etc/passwd', line: 1 }, 'root', 'model'),
    ).resolves.toBeNull();
  });

  it('rejects a missing file', async () => {
    await expect(
      verifyCandidate(root, { path: 'Nope.java', line: 1 }, 'doThing', 'grep'),
    ).resolves.toBeNull();
  });
});

// The bounded line reader behind verifyCandidate. It replaced a
// readFileSync-plus-split of files up to 8MB, per candidate, on the
// main-process thread — so what matters is that it still returns exactly
// the same line, including at the awkward boundaries.
describe('readLineAt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-readline-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(name: string, content: string): string {
    const p = path.join(root, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it('reads the first, middle and last line', async () => {
    const p = write('three.txt', 'one\ntwo\nthree\n');
    expect(await readLineAt(p, 1)).toBe('one');
    expect(await readLineAt(p, 2)).toBe('two');
    expect(await readLineAt(p, 3)).toBe('three');
  });

  it('reads a final line with no trailing newline', async () => {
    const p = write('nonl.txt', 'alpha\nomega');
    expect(await readLineAt(p, 2)).toBe('omega');
  });

  it('handles CRLF files without keeping the carriage return', async () => {
    const p = write('crlf.txt', 'one\r\ntwo\r\n');
    expect(await readLineAt(p, 2)).toBe('two');
  });

  it('reads a line that straddles the internal chunk boundary', async () => {
    // The reader walks 64KB chunks, so a line crossing that boundary is
    // the case a naive implementation gets wrong.
    const filler = 'x'.repeat(70_000);
    const p = write('big.txt', `${filler}\nneedle here\n`);
    expect(await readLineAt(p, 2)).toBe('needle here');
  });

  it('returns null past end of file, for line 0, and for a directory', async () => {
    const p = write('short.txt', 'only\n');
    expect(await readLineAt(p, 5)).toBeNull();
    expect(await readLineAt(p, 0)).toBeNull();
    expect(await readLineAt(root, 1)).toBeNull();
    expect(await readLineAt(path.join(root, 'missing.txt'), 1)).toBeNull();
  });

  it('gives up rather than scanning past the byte cap', async () => {
    const p = write('capped.txt', `${'a\n'.repeat(50_000)}target\n`);
    expect(await readLineAt(p, 50_001, 1_000)).toBeNull();
    // Same file, generous cap: the line is found.
    expect(await readLineAt(p, 50_001)).toBe('target');
  });
});

describe('lookupModelLadder', () => {
  it('puts the cheapest fast model first and keeps Haiku', () => {
    const ladder = lookupModelLadder('claude');
    expect(ladder[0]).toBe('claude-haiku-4-5');
    // Unlike the flows detect ladder, which filters Haiku out entirely
    // because a garbled report there is silently wrong. Here every answer
    // is verified against disk, so the cheap rung is safe to try first.
    expect(ladder.length).toBeGreaterThan(1);
  });

  it('offers an escalation rung on every supported backend', () => {
    for (const backend of ['claude', 'codex', 'gemini'] as const) {
      expect(lookupModelLadder(backend).length).toBeGreaterThan(0);
    }
    expect(lookupModelLadder('ollama')).toEqual([]);
  });
});

describe('buildLookupArgs', () => {
  it('pins the model and keeps claude read-only', () => {
    const args = buildLookupArgs('claude', 'claude-haiku-4-5');
    expect(args.slice(0, 2)).toEqual(['--model', 'claude-haiku-4-5']);
    expect(args).toContain('--effort');
    expect(args.join(' ')).toContain('--allowedTools Read Grep Glob');
    // No write tools, and the prompt arrives on stdin.
    expect(args.join(' ')).not.toMatch(/Edit|Write|Bash/);
    expect(args.slice(-2)).toEqual(['-p', '-']);
  });

  it('omits --effort when the installed claude CLI predates it', () => {
    expect(buildLookupArgs('claude', 'claude-haiku-4-5', { effortSupported: false })).not.toContain(
      '--effort',
    );
  });

  it('puts codex -m before exec', () => {
    // `-m` is a top-level codex flag; after `exec` the parser rejects it.
    const args = buildLookupArgs('codex', 'gpt-5.6-luna');
    expect(args.slice(0, 2)).toEqual(['-m', 'gpt-5.6-luna']);
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('exec'));
  });

  it('throws for backends that cannot take a stdin prompt', () => {
    expect(() => buildLookupArgs('copilot', 'claude-haiku-4.5')).toThrow(/copilot/);
    expect(() => buildLookupArgs('ollama', 'llama3')).toThrow(/ollama/);
  });
});
