import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildLookupArgs,
  declarationPatterns,
  gitRootFor,
  isSafeSymbol,
  looksLikeDeclaration,
  lookupModelLadder,
  parseGrepMatches,
  parseModelCandidates,
  resolveSearchRoot,
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

describe('tier 1 declaration matching', () => {
  /// Mirrors what the grep tier actually does: ripgrep matches one of the
  /// (deliberately loose) patterns, then `looksLikeDeclaration` rejects the
  /// false positives rg's engine can't express — it has no lookaround.
  /// Testing the halves separately would let a regression hide in the seam.
  function isDefinition(file: string, symbol: string, line: string): boolean {
    const matched = declarationPatterns(file, symbol).some((p) => new RegExp(p).test(line));
    return matched && looksLikeDeclaration(line, symbol, file);
  }

  /// Each case is [source line, is it a definition of `symbol`?]. Written
  /// as tables because the failure that started this — Java interface
  /// methods never matching — was a *shape* nobody had listed, not a bug in
  /// any single pattern.
  function check(file: string, symbol: string, cases: Array<[string, boolean]>) {
    for (const [line, expected] of cases) {
      expect(isDefinition(file, symbol, line), `${file} ${symbol} :: ${line}`).toBe(expected);
    }
  }

  it('Java: methods with and without bodies', () => {
    check('Service.java', 'doThing', [
      ['  public static Foo doThing(Bar b) {', true],
      ['  private Foo doThing(Bar b) throws IOException {', true],
      // The regression that started this: an interface / abstract method
      // has no body, so requiring `{` on the line missed every one.
      ['  void doThing(Bar b);', true],
      ['  public abstract Foo doThing(Bar b) throws IOException;', true],
      ['  Map<String, List<Foo>> doThing(Bar b);', true],
      // Wrapped signature — the opener is all rg sees on this line.
      ['  public Foo doThing(', true],
      // Call sites must stay out, including the ones that end in `;` and
      // therefore look exactly like an interface method to a regex.
      ['    svc.doThing(b);', false],
      ['    return doThing(b) + 1;', false],
      ['    return doThing(b);', false],
      ['    this.doThing(b);', false],
      ['   * Calls doThing(b) when ready.', false],
      ['import static com.foo.Bar.doThing;', false],
    ]);
  });

  it('Java: type declarations', () => {
    check('Service.java', 'FooService', [
      ['public interface FooService extends Base {', true],
      ['final class FooService {', true],
      ['public record FooService(String a) {', true],
      ['  FooService svc = new FooService();', false],
      ['import com.foo.FooService;', false],
    ]);
  });

  it('TypeScript: functions, arrows, class members', () => {
    check('a.ts', 'handle', [
      ['export function handle(req: Req) {', true],
      ['const handle = async (req) => {', true],
      ['  handle(req: Req): void {', true],
      ['  async handle(req: Req): Promise<void> {', true],
      ['  private static handle(req: Req) {', true],
      ['  handle(', true],
      ['  handle: async function (req) {', true],
      ['    await handle(req);', false],
      ['    return handle(req);', false],
      ['    const r = handle(req);', false],
      ['    this.handle(req);', false],
      ["export { handle } from './handle';", false],
      ["import { handle } from './handle';", false],
    ]);
  });

  it('TypeScript: types and interfaces', () => {
    check('a.ts', 'Options', [
      ['export interface Options {', true],
      ['type Options = {', true],
      ['export type Options<T> = Partial<T>;', true],
      ['  const o: Options = {};', false],
    ]);
  });

  it('JavaScript: CommonJS and prototype shapes', () => {
    check('a.js', 'render', [
      ['function render(props) {', true],
      ['const render = (props) => {', true],
      ['  render(props) {', true],
      ['module.exports.render = function (props) {', true],
      ['    return render(props);', false],
      ['    el.render(props);', false],
    ]);
  });

  it('Python: defs, classes, module-level bindings', () => {
    check('a.py', 'run', [
      ['    def run(self, x):', true],
      ['async def run():', true],
      ['    self.run(x)', false],
      ['    return run(x)', false],
      ['    result = run(x)', false],
      ['# run() is called by the scheduler', false],
    ]);
    check('a.py', 'Runner', [
      ['class Runner:', true],
      ['    r = Runner()', false],
    ]);
    check('a.py', 'DEFAULTS', [
      ['DEFAULTS = {', true],
      ['    x = DEFAULTS["a"]', false],
    ]);
  });

  it('Go: receivers, which the old brace patterns missed entirely', () => {
    check('svc.go', 'doThing', [
      // A bare Go return type has no `:` before it, so the old pattern
      // required punctuation Go never writes.
      ['func (s *Svc) doThing(b Bar) error {', true],
      ['func doThing(b Bar) (Foo, error) {', true],
      ['func (s Svc) doThing() {', true],
      ['	return s.doThing(b)', false],
      ['	doThing(b)', false],
    ]);
    check('svc.go', 'Svc', [
      ['type Svc struct {', true],
      ['	s := Svc{}', false],
    ]);
  });

  it('Ruby: singleton methods and attr_accessor', () => {
    check('a.rb', 'call', [
      ['  def self.call(x)', true],
      ['  def call(x)', true],
      ['  attr_reader :call', true],
      ['  obj.call(x)', false],
    ]);
  });

  it('Rust and C++ keep working through the brace family', () => {
    check('a.rs', 'parse', [
      ['pub fn parse(input: &str) -> Result<Ast> {', true],
      ['    let x = parse(input)?;', false],
    ]);
    check('a.cpp', 'Compute', [
      // Out-of-line definition and header prototype.
      ['void Renderer::Compute(const Frame& f) {', true],
      ['  virtual void Compute(const Frame& f) const;', true],
      ['    Compute(f);', false],
    ]);
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
      { path: path.join('src', 'A.java'), line: 12, text: '  public void go() {' },
      { path: 'src/B.java', line: 99, text: '  void go() {' },
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

describe('resolveSearchRoot', () => {
  // Mirrors the shapes overcli actually produces: a real project, a linked
  // worktree (`.git` is a FILE, not a directory), and a workspace root
  // that's a directory of symlinks pointing at both.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-roots-'));
  const project = path.join(tmp, 'project');
  const worktree = path.join(tmp, 'worktrees', 'agent-1');
  const wsRoot = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'A.java'), 'class A {}\n');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  // A linked worktree's .git is a file containing a gitdir pointer.
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${project}/.git/worktrees/agent-1\n`);
  fs.writeFileSync(path.join(worktree, 'src', 'A.java'), 'class A {}\n');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.symlinkSync(project, path.join(wsRoot, 'project'));
  fs.symlinkSync(worktree, path.join(wsRoot, 'agent-1'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const real = (p: string) => fs.realpathSync.native(p);

  it('keeps the caller root when the file really lives under it', () => {
    expect(resolveSearchRoot(path.join(project, 'src', 'A.java'), project)).toBe(real(project));
  });

  it('falls back to the worktree when the caller root is a different tree', () => {
    // The flow case: conversation root is the project, but the file being
    // viewed is the agent's copy in a minted worktree. Searching `project`
    // would scan the wrong tree and then reject every hit for resolving
    // outside it — the lookup returns nothing, with no clue why.
    expect(resolveSearchRoot(path.join(worktree, 'src', 'A.java'), project)).toBe(real(worktree));
  });

  it('resolves through a workspace symlink root to the real tree', () => {
    // ripgrep does not follow symlinks by default, so searching wsRoot
    // itself scans a directory of links and matches nothing.
    expect(resolveSearchRoot(path.join(wsRoot, 'agent-1', 'src', 'A.java'), wsRoot)).toBe(
      real(worktree),
    );
    expect(resolveSearchRoot(path.join(wsRoot, 'project', 'src', 'A.java'), wsRoot)).toBe(
      real(project),
    );
  });

  it('finds the git root when no usable caller root is supplied', () => {
    expect(resolveSearchRoot(path.join(project, 'src', 'A.java'), '')).toBe(real(project));
  });

  it('falls back to the file directory outside any repo', () => {
    const loose = path.join(tmp, 'loose');
    fs.mkdirSync(loose, { recursive: true });
    fs.writeFileSync(path.join(loose, 'x.ts'), 'export const x = 1;\n');
    expect(resolveSearchRoot(path.join(loose, 'x.ts'), '')).toBe(real(loose));
  });
});

describe('gitRootFor', () => {
  it('accepts .git as a file, which is how linked worktrees mark their root', () => {
    const seen = new Set(['/repo/wt/.git']);
    expect(gitRootFor('/repo/wt/src/A.java', (p) => seen.has(p))).toBe(path.resolve('/repo/wt'));
  });

  it('returns null when nothing above the file is a repo', () => {
    expect(gitRootFor('/nowhere/a/b.ts', () => false)).toBeNull();
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
