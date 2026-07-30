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

  it('accepts a line that actually mentions the symbol', () => {
    const got = verifyCandidate(root, { path: 'Service.java', line: 3 }, 'doThing', 'grep');
    expect(got).toMatchObject({
      path: 'Service.java',
      absolutePath: file,
      line: 3,
      snippet: 'public void doThing() {',
      source: 'grep',
    });
  });

  it('rejects a line that does not mention the symbol', () => {
    // This is the check that makes the cheap model tier safe: a plausible
    // but wrong path:line is caught here instead of jumping the user
    // somewhere arbitrary.
    expect(verifyCandidate(root, { path: 'Service.java', line: 1 }, 'doThing', 'model')).toBeNull();
  });

  it('requires a whole-word match', () => {
    // `doThing` must not validate against a hit on `doThingElse`.
    const other = path.join(root, 'Other.java');
    fs.writeFileSync(other, 'void doThingElse() {}\n');
    expect(verifyCandidate(root, { path: 'Other.java', line: 1 }, 'doThing', 'model')).toBeNull();
  });

  it('rejects lines past end of file', () => {
    expect(verifyCandidate(root, { path: 'Service.java', line: 999 }, 'doThing', 'grep')).toBeNull();
  });

  it('rejects paths that escape the project root', () => {
    expect(
      verifyCandidate(root, { path: '../../etc/passwd', line: 1 }, 'root', 'model'),
    ).toBeNull();
  });

  it('rejects a missing file', () => {
    expect(verifyCandidate(root, { path: 'Nope.java', line: 1 }, 'doThing', 'grep')).toBeNull();
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
