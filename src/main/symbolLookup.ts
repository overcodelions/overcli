// Go-to-definition for the file editor.
//
// Two tiers, cheapest first:
//
//   1. ripgrep declaration patterns. For a distinctly-named symbol this
//      resolves in ~10ms for zero tokens, which is the common case — most
//      method names in a codebase are unique enough that one
//      declaration-shaped line matches. No model is spawned at all.
//   2. A one-shot CLI query on the cheapest fast model (Haiku on claude).
//      Reached automatically only when grep found NOTHING
//      (inherited/generated/generic-heavy definitions). When grep found
//      several candidates we hand those back immediately and let the user
//      ask for the model via `refine()` — a picker on screen in 20ms beats
//      a better-ordered picker several seconds later, and it keeps a click
//      from spending model time nobody asked for.
//
// Everything on this path is async and bounded. The first version ran
// ripgrep through spawnSync and read whole candidate files with
// readFileSync, on the main-process thread — the same thread that brokers
// every streaming IPC message from every running agent, so one Cmd-click
// stalled every conversation in the app for as long as the search took.
// That's the bug f731162 fixed for detectGpu; the rules are the same here.
//
// Both tiers hand back *candidates*, and every candidate is verified
// against the file on disk before it leaves this module: the path must
// resolve inside the project root, the line must exist, and the line must
// actually mention the symbol. That verification is what makes tier 2
// viable on Haiku — `detectModelLadder` in flows/runtime.ts deliberately
// excludes Haiku because a garbled watch report is silently wrong, but a
// wrong `path:line` here fails the check and escalates one rung instead.
//
// This runs off the main conversation entirely (same shape as
// ReviewerManager): its own short-lived process, its own model, nothing
// written to any transcript. Clicking a symbol must not perturb the
// agent's context.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PREMIUM_MODELS, modelSpeed } from '../shared/modelCatalog';
import type { Backend, SymbolCandidate, SymbolLookupResult } from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import { claudeSupportsEffort, extractReviewerDisplay } from './reviewer';

/// Symbols are matched into regexes we build below, so the character set
/// has to be closed: no regex metacharacters, no leading `-` (which would
/// otherwise reach a CLI as a flag — the option-injection class of bug
/// f731162 fixed for refs and ids). Identifier-shaped only.
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

const GREP_TIMEOUT_MS = 3_000;
const MODEL_TIMEOUT_MS = 25_000;
/// Grep is a pre-filter, not a search UI. More than this many
/// declaration-shaped hits means the name is common (`get`, `run`) and the
/// model tier will do a better job than a long list would.
const MAX_GREP_CANDIDATES = 8;
const MAX_MODEL_CANDIDATES = 5;
/// Short enough that an edit to the definition site isn't stale for long,
/// long enough that walking a call chain doesn't re-pay for each hop.
const CACHE_TTL_MS = 120_000;
/// Failures are cached too, but briefly. A miss is often circumstantial
/// (file not saved yet, rg missing) so it has to expire fast — but not
/// caching it at all meant every repeat click on an unresolvable symbol
/// re-paid the whole ladder, up to two model spawns, for the same answer.
const CACHE_TTL_MISS_MS = 20_000;
const CACHE_MAX_ENTRIES = 500;
/// Ceiling on the bytes we'll scan to reach a candidate's line. Well past
/// any real source file, and it caps the work a bogus `path:line` from the
/// model tier can cause.
const VERIFY_MAX_BYTES = 2_000_000;

/// Sibling extensions to restrict the grep to. A Java method is defined in
/// a `.java` file; searching the whole tree just adds noise from vendored
/// JS and fixtures. Unlisted extensions search everything.
const EXT_FAMILIES: string[][] = [
  ['.java'],
  ['.kt', '.kts'],
  ['.scala', '.sbt'],
  ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  ['.py', '.pyi'],
  ['.rb', '.rake'],
  ['.go'],
  ['.rs'],
  ['.c', '.h'],
  ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  ['.cs'],
  ['.swift'],
  ['.php'],
  ['.dart'],
  ['.ex', '.exs'],
];

export function isSafeSymbol(symbol: string): boolean {
  return SYMBOL_RE.test(symbol);
}

/// Extensions worth searching for a definition referenced from `filePath`.
/// Empty means "no restriction".
export function siblingExtensions(filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return [];
  return EXT_FAMILIES.find((fam) => fam.includes(ext)) ?? [];
}

export type LanguageFamily = 'python' | 'ruby' | 'elixir' | 'go' | 'js' | 'brace';

/// Which pattern set to use for a file. Families are grouped by *syntax*,
/// not by ecosystem: Java, C#, Kotlin, Swift, Scala, Dart, PHP and C/C++
/// all declare methods the same shape (modifiers, return type, name,
/// params) so they share one set.
export function languageFamily(filePath: string): LanguageFamily {
  switch (path.extname(filePath).toLowerCase()) {
    case '.py':
    case '.pyi':
      return 'python';
    case '.rb':
    case '.rake':
      return 'ruby';
    case '.ex':
    case '.exs':
      return 'elixir';
    case '.go':
      return 'go';
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'js';
    default:
      return 'brace';
  }
}

/// Declaration-shaped regexes for `symbol`, in **ripgrep's** dialect.
///
/// These are deliberately broader than the truth. ripgrep uses Rust's
/// regex crate, which has no lookaround, so a single pattern cannot say
/// "a declaration but not `return foo(x);`". Rather than tighten these
/// until they miss real declarations (the old pattern set required a
/// body-opening `{` on the same line, so every Java interface method and
/// every wrapped signature fell through to the model tier), we let rg cast
/// a wide net and reject the false positives in `looksLikeDeclaration`,
/// which runs in JS where full regex is available.
///
/// Bounded quantifiers throughout: these same patterns get re-run under
/// `rg -U` for wrapped signatures, where an unbounded `[^;{]*` could span
/// a whole file.
export function declarationPatterns(filePath: string, symbol: string): string[] {
  // `symbol` is identifier-shaped (isSafeSymbol), so it needs no escaping.
  const s = symbol;
  /// Modifiers / return types preceding a name: `public static
  /// Map<String, Foo> `, `@Override private `, `virtual const char *`.
  ///
  /// The leading `[\w@]` is load-bearing: it requires at least one real
  /// token before the name, so an indented bare call statement —
  /// `    Compute(f);` — can't satisfy the no-body pattern with nothing but
  /// whitespace. A declaration always names a type or a modifier first.
  const lead = String.raw`\s*[\w@][\w\s@<>\[\],.$*&:?]{0,200}`;
  /// Whatever sits between `)` and the body: `throws IOException`,
  /// `: Promise<void>`, `const noexcept`, Go's bare `error`.
  const tail = String.raw`[\w\s<>\[\],.$*&:?()]{0,160}`;

  switch (languageFamily(filePath)) {
    case 'python':
      return [
        String.raw`^\s*(async\s+)?def\s+${s}\b`,
        String.raw`^\s*class\s+${s}\b`,
        // Module-level binding: `FOO = ...`, `foo: Final = ...`. Anchored
        // at column 0 so locals inside functions don't flood the results.
        String.raw`^${s}\s*(:[^=\n]{0,80})?=`,
      ];

    case 'ruby':
      return [
        String.raw`^\s*def\s+(self\.)?${s}\b`,
        String.raw`^\s*(class|module)\s+${s}\b`,
        // `attr_reader :foo` and friends generate real methods.
        String.raw`^\s*attr_(reader|writer|accessor)\s+.{0,80}:${s}\b`,
      ];

    case 'elixir':
      return [
        String.raw`^\s*def(p|macro|macrop)?\s+${s}\b`,
        String.raw`^\s*defmodule\s+.{0,80}${s}\b`,
      ];

    case 'go':
      // Go declares only at top level, so anchoring kills call sites for
      // free — no JS-side filtering needed for these.
      return [
        String.raw`^func\s+${s}\s*[(\[]`,
        // Method with a receiver: `func (s *Svc) doThing(b Bar) error {`.
        // The old brace pattern missed every one of these, because a bare
        // Go return type has no `:` before it.
        String.raw`^func\s*\([^)\n]{0,80}\)\s*${s}\s*[(\[]`,
        String.raw`^\s*type\s+${s}\b`,
        String.raw`^\s*(var|const)\s+${s}\b`,
      ];

    case 'js':
      return [
        String.raw`\b(function|class|interface|enum|namespace)\s+${s}\b`,
        String.raw`\btype\s+${s}\s*[=<]`,
        // `const foo = ...` covers arrows, function expressions and plain
        // values. Broad on purpose — in TS/JS the binding *is* usually the
        // definition, and looksLikeDeclaration drops `= foo(` call results.
        String.raw`\b(const|let|var)\s+${s}\s*[:=]`,
        // Class / object method, with or without a body on the same line:
        //   async doThing(req: Req): Promise<void> {
        //   get value() {
        String.raw`^\s*(export\s+|default\s+|async\s+|static\s+|readonly\s+|abstract\s+|private\s+|protected\s+|public\s+|get\s+|set\s+|\*\s*){0,4}${s}\s*(<[^>\n]{0,80}>)?\s*\([^;{\n]{0,200}\)\s*(:${tail})?\s*[{;]`,
        // Object-literal member: `foo: async function (`, `foo: (a) => {`.
        String.raw`\b${s}\s*:\s*(async\s+)?(function\b|\()`,
        // Assigned to a property rather than a binding:
        // `module.exports.render = function (props) {`,
        // `Foo.prototype.render = (props) => {`.
        String.raw`\b${s}\s*=\s*(async\s+)?(function\b|\(|<)`,
        // Wrapped signature — the name is the last thing on its line.
        String.raw`^\s*(export\s+|async\s+|static\s+|const\s+|function\s+){0,3}${s}\s*\(\s*$`,
      ];

    case 'brace':
    default:
      return [
        // Keyword-introduced: `fn foo`, `func foo`, `sub foo`, `def foo`.
        String.raw`\b(fn|func|function|sub|def)\s+${s}\s*[(<]`,
        // Type declarations.
        String.raw`\b(class|interface|struct|enum|trait|record|protocol|object|typealias|namespace|type)\s+${s}\b`,
        // Method with a body opening on the same line. `tail` is now a
        // general token run rather than requiring `:` — that's what lets
        // `throws IOException`, `const noexcept`, and bare return types
        // through.
        String.raw`\b${s}\s*\([^;{\n]{0,200}\)\s*(${tail})?[{]`,
        // Method with NO body: interface methods, abstract methods, C/C++
        // prototypes. Requires a lead-in on the same line so a bare
        // `foo(x);` call statement can't match on its own — and
        // looksLikeDeclaration rejects `return foo(x);` afterwards.
        String.raw`^${lead}\s${s}\s*\([^;{\n]{0,200}\)\s*(${tail})?;`,
        // Wrapped signature opener: `public Foo doThing(` then params on
        // the following lines. ripgrep is line-oriented, so without this
        // (plus the -U pass in grepTier) every wrapped Java/Kotlin/C#
        // declaration is invisible to tier 1.
        String.raw`^${lead}\s${s}\s*\(\s*$`,
        // Field / property with an initializer, and C#-style expression
        // bodies: `private final Foo bar =`, `public Foo Bar => ...`.
        String.raw`^${lead}\s${s}\s*(=[^=]|=>)`,
      ];
  }
}

/// Nearest enclosing git root for a file, or null. Checks for `.git` as an
/// *entry* rather than a directory on purpose: a linked worktree's `.git`
/// is a file containing a gitdir pointer, and worktrees are exactly the
/// case this exists to handle.
export function gitRootFor(
  filePath: string,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  let dir = path.dirname(path.resolve(filePath));
  // Bounded so a pathological path can't spin.
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/// Which tree to actually search for a definition.
///
/// The caller's `cwd` is the *conversation's* root, and in a flow run that
/// is routinely not the tree the open file lives in: flow worktree runs
/// mint a worktree outside the project, and workspace/coordinator roots are
/// directories of symlinks rather than real source. Searching the passed
/// root there finds nothing (ripgrep doesn't follow symlinks by default)
/// and, worse, `verifyCandidate` rejects every hit for resolving outside
/// the root — the lookup comes back empty with no indication why.
///
/// So: resolve both sides through their real paths, keep the caller's root
/// when the file genuinely lives under it, and otherwise fall back to the
/// file's own git root. That covers plain projects, symlinked projects,
/// workspace symlink roots, and minted worktrees with one rule.
export function resolveSearchRoot(
  filePath: string,
  requestedCwd: string,
  realpath: (p: string) => string = realpathOrSelf,
): string {
  const realFile = realpath(path.resolve(filePath));
  if (requestedCwd) {
    const realCwd = realpath(path.resolve(requestedCwd));
    const rel = path.relative(realCwd, realFile);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return realCwd;
  }
  return gitRootFor(realFile) ?? path.dirname(realFile);
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/// Shapes that can never be a definition, however much they look like one
/// to a line-oriented regex.
///
/// This is the precision half of the grep tier. ripgrep's engine has no
/// lookaround, so `declarationPatterns` cannot distinguish
/// `public Foo doThing(Bar b);` (an interface method) from
/// `return doThing(b);` (a call) — both are "tokens, name, parens,
/// semicolon". Here we have full JS regex, including lookbehind, so the
/// rejects are expressible.
export function looksLikeDeclaration(text: string, symbol: string, filePath: string): boolean {
  const line = text.trim();
  if (!line) return false;
  const s = symbol;

  // Comment-only lines. Doc comments mention `foo()` constantly.
  if (/^(\/\/|\/\*|\*|#|--|;;)/.test(line)) return false;

  // An introducer keyword directly before the name settles it: this is a
  // declaration, and none of the call-site rejects below apply. Without
  // this early accept, Ruby's `def self.call(x)` gets thrown out by the
  // receiver-call rule for the `.call(` it contains.
  if (
    new RegExp(
      String.raw`^(export\s+|default\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|async\s+|pub\s+|open\s+|override\s+|suspend\s+){0,4}(def|defp|defmacro|function|fn|func|sub|class|module|interface|struct|enum|trait|protocol|record|object|namespace|typealias|type)\s+(self\.)?${s}\b`,
    ).test(line)
  ) {
    return true;
  }

  // Imports and re-exports name the symbol but aren't where it's defined —
  // jumping here would strand the user one hop short. `export function foo`
  // and `export const foo` are declarations and must survive, so only
  // brace-form re-exports are rejected.
  if (/^(import|from|using|#include|require)\b/.test(line)) return false;
  if (/^export\s*[{*]/.test(line)) return false;

  // The rejects below all describe what sits *before* the name, so they
  // must only see the first occurrence of it. A one-line body that calls
  // itself — `func (s *Svc) doThing(b Bar) error { return s.doThing(b) }`,
  // or a recursive arrow — otherwise gets thrown out by its own body: the
  // declaration is real, but `.doThing(` appears later on the same line.
  // The synthesized `(` keeps the call-shaped patterns matchable after the
  // truncation.
  // The `(` is re-attached only when the real line has one there. Adding it
  // unconditionally would invent a call shape for names that aren't called
  // at all — `module.exports.render = function (props)` would read as
  // `.render(`, and Ruby's `attr_reader :call` as `:call(`.
  const firstUse = new RegExp(String.raw`\b${s}\b`).exec(line);
  const head = firstUse
    ? line.slice(0, firstUse.index + s.length) +
      (/^\s*\(/.test(line.slice(firstUse.index + s.length)) ? '(' : '')
    : line;

  // A statement keyword immediately before the name means it's being
  // called, not declared: `return doThing(b);`, `throw newError(x);`.
  // NB: `void` is deliberately absent. It's a JS operator but a return type
  // in Java, C, C++ and C#, where `void doThing(Bar b);` is the single most
  // common declaration shape there is.
  if (
    new RegExp(String.raw`(?<![\w$.])(return|throw|new|await|yield|typeof|delete|case|in|of|and|or|not)\s+${s}\s*\(`).test(
      head,
    )
  ) {
    return false;
  }

  // A call on a receiver: `svc.doThing(b)`, `this.doThing()`. Note this
  // does not reject `Foo.prototype.doThing = function` — there the name is
  // followed by ` =`, not `(`.
  if (new RegExp(String.raw`[.?]\s*${s}\s*\(`).test(head)) return false;

  // Assigning the *result* of a call: `const x = doThing(b)`. Distinct
  // from `const doThing = (b) => ...`, where the name precedes the `=`.
  // The `(?<!:)` guard keeps C++ scope resolution out of it — in
  // `void Renderer::Compute(...)` the second colon is not an assignment.
  if (new RegExp(String.raw`(?<!:)[=:]\s*(await\s+)?${s}\s*\(`).test(head)) return false;

  // Python and Ruby declare with an unambiguous keyword, so anything that
  // reached here without one is a false positive from the broad
  // module-level-binding pattern.
  const family = languageFamily(filePath);
  if (family === 'python' && /\(/.test(line) && !/^\s*(async\s+)?(def|class)\b/.test(line)) {
    return false;
  }

  return true;
}

/// Parse `path:line:text` lines from `rg --no-heading -n`. Absolute paths
/// are relativized against `cwd` so candidates are stable to display.
///
/// The matched text comes back too — `looksLikeDeclaration` needs it, and
/// re-reading the line from disk to get it would cost a file read per
/// match. Under `rg -U` a match spans lines; only the first carries the
/// `path:line:` prefix, and that's the line we want (a wrapped signature
/// starts at its first line), so continuation lines simply don't parse.
export function parseGrepMatches(
  stdout: string,
  cwd: string,
): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Windows drive letters mean we can't just split on the first colon.
    const m = /^(.*?):(\d+):/.exec(line);
    if (!m) continue;
    const file = m[1];
    const lineNo = Number(m[2]);
    if (!Number.isInteger(lineNo) || lineNo < 1) continue;
    const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    if (!rel || rel.startsWith('..')) continue;
    out.push({ path: rel, line: lineNo, text: line.slice(m[0].length) });
  }
  return out;
}

/// Pull `path:line` pairs out of the model's reply. The prompt asks for
/// nothing else, but models occasionally wrap output in a fence or prefix
/// a bullet, so we scan rather than demand an exact match. Anything that
/// isn't a well-formed pair is dropped — verification would reject it
/// anyway, and being lenient here beats failing the whole lookup.
export function parseModelCandidates(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*+\d.)\s]+/, '').replace(/[`'"]/g, '');
    if (!line || line === 'NONE') continue;
    const m = /^(.+?):(\d+)\s*$/.exec(line);
    if (!m) continue;
    const rel = m[1].trim();
    const lineNo = Number(m[2]);
    if (!rel || !Number.isInteger(lineNo) || lineNo < 1) continue;
    const key = `${rel}:${lineNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: rel, line: lineNo });
    if (out.length >= MAX_MODEL_CANDIDATES) break;
  }
  return out;
}

/// Read one 1-based line out of a file without materializing the whole
/// thing. The old version read up to 8MB into a string and split it on
/// every newline just to look at one line — per candidate, and up to
/// thirteen candidates per lookup. This walks chunks until it reaches the
/// line it wants and stops, so cost tracks the line's *offset* rather than
/// the file's size. Returns null past EOF or past VERIFY_MAX_BYTES.
export async function readLineAt(
  filePath: string,
  line: number,
  maxBytes = VERIFY_MAX_BYTES,
): Promise<string | null> {
  if (!Number.isInteger(line) || line < 1) return null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buf = Buffer.allocUnsafe(64 * 1024);
    // `carry` holds the tail of the previous chunk — a line can straddle a
    // chunk boundary, so we only consume up to the last newline we saw.
    let carry = '';
    let current = 1;
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) {
        // EOF. A final line with no trailing newline still counts.
        return current === line ? carry : null;
      }
      read += bytesRead;
      if (read > maxBytes) return null;
      carry += buf.toString('utf-8', 0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = carry.indexOf('\n', start);
        if (nl === -1) break;
        if (current === line) return carry.slice(start, nl).replace(/\r$/, '');
        current += 1;
        start = nl + 1;
      }
      carry = carry.slice(start);
      // A single "line" longer than the cap is not source we can verify.
      if (carry.length > maxBytes) return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/// Confirm a candidate points at something real before we let the UI jump
/// to it: inside the project root, line in range, and the line actually
/// mentions the symbol. Returns the candidate with its source line as a
/// snippet, or null.
export async function verifyCandidate(
  cwd: string,
  candidate: { path: string; line: number },
  symbol: string,
  source: SymbolCandidate['source'],
): Promise<SymbolCandidate | null> {
  const resolved = path.resolve(cwd, candidate.path);
  // Traversal / symlink escape guard — the model supplies this path, so
  // it is untrusted input even though the model is ours.
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (resolved !== cwd && !resolved.startsWith(root)) return null;

  const lineText = await readLineAt(resolved, candidate.line);
  if (lineText == null) return null;
  // Word-boundary check, not substring: `getUser` must not validate a hit
  // on `getUserName`.
  if (!new RegExp(String.raw`\b${symbol}\b`).test(lineText)) return null;

  return {
    path: path.relative(cwd, resolved) || path.basename(resolved),
    absolutePath: resolved,
    line: candidate.line,
    snippet: lineText.trim().slice(0, 200),
    source,
  };
}

/// Verify a batch of candidates concurrently, keeping input order.
async function verifyAll(
  cwd: string,
  candidates: Array<{ path: string; line: number }>,
  symbol: string,
  source: SymbolCandidate['source'],
): Promise<SymbolCandidate[]> {
  const checked = await Promise.all(
    candidates.map((c) => verifyCandidate(cwd, c, symbol, source)),
  );
  return dedupe(checked.filter((c): c is SymbolCandidate => c !== null));
}

/// Cheapest-fast-model-first ladder for the lookup tier.
///
/// `PREMIUM_MODELS` is ordered premium-first, so reversing the fast subset
/// gives cheapest-first — the same convention `detectModelLadder` uses.
/// Unlike that ladder we KEEP Haiku: it's the cheapest fast model, and the
/// reason detect excludes it (silently garbled output) doesn't apply to a
/// `path:line` answer we verify against disk before trusting.
export function lookupModelLadder(backend: Backend): string[] {
  if (backend === 'ollama') return [];
  const fast = (PREMIUM_MODELS[backend as Exclude<Backend, 'ollama'>] ?? []).filter(
    (m) => modelSpeed(m) === 'fast',
  );
  return [...fast].reverse();
}

/// Args for a one-shot, read-only, text-out lookup query. Prompt arrives
/// on stdin (`-`), same as the reviewer.
export function buildLookupArgs(
  backend: Backend,
  model: string,
  opts: { effortSupported?: boolean } = {},
): string[] {
  switch (backend) {
    case 'claude': {
      const a = ['--model', model];
      // Older CLIs exit on an unknown --effort; probed at the call site.
      if (opts.effortSupported !== false) a.push('--effort', 'low');
      a.push('--permission-mode', 'default');
      // Read-only by construction: the lookup reads code, never writes.
      // --permission-mode default means anything off this list would need
      // approval, and -p has nobody to ask, so it simply can't fire.
      a.push('--allowedTools', 'Read Grep Glob');
      // Plain text out — the contract is one `path:line` per line, so
      // there's no reason to parse stream-json here.
      a.push('-p', '-');
      return a;
    }
    case 'codex':
      // `-m` is a top-level flag and must precede `exec`.
      return ['-m', model, 'exec', '--skip-git-repo-check', '-'];
    case 'gemini':
      return ['-m', model, '-p', '-'];
    default:
      throw new Error(`Symbol lookup is not supported on the ${backend} backend`);
  }
}

export function buildLookupPrompt(args: {
  symbol: string;
  relFile: string;
  line: number;
  contextLines: string;
}): string {
  return [
    'You are a code-navigation tool. Find where a symbol is DEFINED — not where it is called.',
    '',
    `Symbol: ${args.symbol}`,
    `Referenced at: ${args.relFile}:${args.line}`,
    '',
    'Surrounding code:',
    args.contextLines,
    '',
    'Use Grep/Glob/Read to locate the definition. To disambiguate between',
    'same-named candidates, use the referencing file\'s imports (only',
    'imported types are in scope) and the declared type of the receiver.',
    'If the symbol is a method on an interface, prefer the interface',
    'declaration, then list implementations.',
    '',
    'OUTPUT CONTRACT — follow exactly:',
    'Respond with nothing but lines of the form',
    '  relative/path/to/File.ext:LINE',
    'Most likely first, at most 5 lines. Paths relative to the project root.',
    'No prose, no markdown, no code fences, no explanation, no trailing notes.',
    'If you cannot find the definition, respond with exactly: NONE',
  ].join('\n');
}

interface CacheEntry {
  result: SymbolLookupResult;
  at: number;
}

export interface SymbolLookupArgs {
  cwd: string;
  /// Absolute path of the file the symbol was clicked in.
  filePath: string;
  symbol: string;
  /// 1-based line the click landed on. Context for the model only.
  line: number;
}

export class SymbolLookupManager {
  private cache = new Map<string, CacheEntry>();
  /// `refine()` answers the same (cwd, ext, symbol) key with a different
  /// (model-derived) result, so it gets its own map rather than a key
  /// prefix — one lookup's answer must never be served from the other's.
  private refineCache = new Map<string, CacheEntry>();
  /// Dedupes concurrent identical lookups — a double Cmd-click shouldn't
  /// spawn two processes.
  private pending = new Map<string, Promise<SymbolLookupResult>>();
  private inFlight = new Set<ReturnType<typeof spawn>>();

  constructor(
    private deps: {
      backendFor: () => { backend: Backend; binary: string | null };
    },
  ) {}

  /// Kill any in-flight lookup processes (app shutdown).
  dispose(): void {
    for (const proc of this.inFlight) {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    this.inFlight.clear();
    this.pending.clear();
    this.cache.clear();
    this.refineCache.clear();
  }

  async find(args: SymbolLookupArgs): Promise<SymbolLookupResult> {
    return this.run(args, 'find', (cwd, symbol) => this.runLookup(cwd, args, symbol));
  }

  /// The user asked for a model opinion on an ambiguous grep answer. Skips
  /// the grep tier entirely and caches under its own key, so refining once
  /// doesn't make every later click on that symbol pay for a model.
  async refine(args: SymbolLookupArgs): Promise<SymbolLookupResult> {
    return this.run(args, 'refine', (cwd, symbol) => this.runModelTier(cwd, args, symbol));
  }

  /// Shared validation, caching and in-flight dedupe for both entry points.
  private async run(
    args: SymbolLookupArgs,
    kind: 'find' | 'refine',
    work: (cwd: string, symbol: string) => Promise<SymbolLookupResult>,
  ): Promise<SymbolLookupResult> {
    const symbol = (args.symbol ?? '').trim();
    if (!isSafeSymbol(symbol)) {
      return { ok: false, error: 'Not a symbol Overcli can look up.' };
    }
    const cwd = args.cwd;
    if (!cwd || !path.isAbsolute(cwd)) {
      return { ok: false, error: 'No project root for this file.' };
    }

    const key = `${cwd}\u0000${path.extname(args.filePath).toLowerCase()}\u0000${symbol}`;
    const cache = kind === 'find' ? this.cache : this.refineCache;
    const hit = cache.get(key);
    // Failures expire far sooner than answers: a miss is often
    // circumstantial (file not saved yet, rg missing), but not caching it
    // at all meant every repeat click on an unresolvable symbol re-ran the
    // whole ladder — up to two model spawns — for the same answer.
    if (hit && Date.now() - hit.at < (hit.result.ok ? CACHE_TTL_MS : CACHE_TTL_MISS_MS)) {
      return hit.result.ok ? { ...hit.result, via: 'cache' } : hit.result;
    }
    const pendingKey = `${kind}:${key}`;
    const inflight = this.pending.get(pendingKey);
    if (inflight) return inflight;

    const run = work(cwd, symbol)
      .then((result) => {
        if (!result.ok || result.candidates.length > 0) this.remember(cache, key, result);
        return result;
      })
      .finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, run);
    return run;
  }

  private remember(
    cache: Map<string, CacheEntry>,
    key: string,
    result: SymbolLookupResult,
  ): void {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      // Cheap eviction: drop the oldest insertion. Map preserves order.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { result, at: Date.now() });
  }

  private async runLookup(
    cwd: string,
    args: SymbolLookupArgs,
    symbol: string,
  ): Promise<SymbolLookupResult> {
    const grepped = await this.grepTier(cwd, args.filePath, symbol);

    // Exactly one verified declaration — done, for free.
    if (grepped.length === 1) {
      return { ok: true, candidates: grepped, via: 'grep' };
    }

    // Several candidates: answer NOW. This used to spend a model call (two,
    // on a bad day, at 25s apiece) to rank a list it already had, and then
    // fall back to that very list when the model's answer didn't verify —
    // so the common ambiguous case paid seconds of latency for a picker we
    // could show in ~20ms. `refinable` lets the picker offer the model as an
    // explicit action instead.
    if (grepped.length > 1) {
      return { ok: true, candidates: grepped, via: 'grep', refinable: this.canRefine() };
    }

    // Grep found nothing at all — inherited, generated, or generic-heavy
    // definitions. Here the model tier is the only thing that can answer,
    // so it runs without being asked.
    return this.runModelTier(cwd, args, symbol);
  }

  /// Whether a model tier is available to refine with. Cheap: a resolved
  /// binary and at least one fast model on the ladder.
  private canRefine(): boolean {
    const { backend, binary } = this.deps.backendFor();
    return !!binary && lookupModelLadder(backend).length > 0;
  }

  /// Tier 2 on its own. Reached automatically when grep came up empty, and
  /// on demand from `refine()`.
  private async runModelTier(
    cwd: string,
    args: SymbolLookupArgs,
    symbol: string,
  ): Promise<SymbolLookupResult> {
    const { backend, binary } = this.deps.backendFor();
    if (!binary) {
      return { ok: false, error: `No ${backend} CLI found to resolve "${symbol}".` };
    }
    const ladder = lookupModelLadder(backend);
    if (ladder.length === 0) {
      return { ok: false, error: `No fast model available on the ${backend} backend.` };
    }

    // Escalate at most one rung. The cheap model is right most of the
    // time; if its answer doesn't verify, one retry on a stronger model is
    // worth the latency, but a full climb is not.
    for (const model of ladder.slice(0, 2)) {
      const text = await this.askModel({ cwd, args, symbol, backend, binary, model });
      if (text == null) continue;
      const verified = await verifyAll(cwd, parseModelCandidates(text), symbol, 'model');
      if (verified.length > 0) {
        return { ok: true, candidates: verified, via: 'model', model };
      }
    }
    return { ok: false, error: `Could not find a definition for "${symbol}".` };
  }

  /// Tier 1. Returns verified candidates, capped. An empty array means
  /// either no match or no ripgrep — both fall through to the model.
  private async grepTier(
    cwd: string,
    filePath: string,
    symbol: string,
  ): Promise<SymbolCandidate[]> {
    const single = await this.grepPass(cwd, filePath, symbol, false);
    if (single.length > 0) return single;
    // Nothing on the line-oriented pass. Before handing the question to a
    // model, retry in multiline mode: a signature whose parameters wrap
    // across lines is invisible to line-oriented matching, and that shape
    // is everywhere in Java, Kotlin and TS. Only on the empty path, so the
    // common case never pays for the slower scan.
    return this.grepPass(cwd, filePath, symbol, true);
  }

  private async grepPass(
    cwd: string,
    filePath: string,
    symbol: string,
    multiline: boolean,
  ): Promise<SymbolCandidate[]> {
    const patterns = declarationPatterns(filePath, symbol);
    const rgArgs = ['--no-heading', '-n', '-s', '--max-count', '4'];
    // In multiline mode `[^;{]` matches newlines too, so the same patterns
    // span a wrapped signature. Every quantifier in them is bounded, which
    // is what keeps that from running away across a whole file.
    if (multiline) rgArgs.push('-U');
    for (const ext of siblingExtensions(filePath)) {
      rgArgs.push('--glob', `*${ext}`);
    }
    for (const p of patterns) {
      rgArgs.push('-e', p);
    }
    // `--` before the path so a cwd that somehow starts with `-` can't be
    // read as a flag.
    rgArgs.push('--', cwd);

    const res = await this.runRipgrep(rgArgs);
    // rg missing (ENOENT) or timed out — skip the tier silently.
    if (!res) return [];
    // status 1 is "no matches", which is a normal outcome.
    if (res.status !== 0 && res.status !== 1) return [];

    // Precision pass. The rg patterns are deliberately loose (no lookaround
    // in Rust's regex engine); this is where call sites, imports and
    // comments that matched them get dropped.
    const matches = parseGrepMatches(res.stdout, cwd).filter((m) =>
      looksLikeDeclaration(m.text, symbol, filePath),
    );
    const verified = await verifyAll(cwd, matches, symbol, 'grep');
    return verified.length > MAX_GREP_CANDIDATES ? [] : verified;
  }

  /// Run ripgrep off-thread. This was `spawnSync` — up to GREP_TIMEOUT_MS of
  /// the main-process thread blocked per Cmd-click, which also blocks every
  /// agent's streaming IPC. Returns null when rg is absent or timed out.
  private runRipgrep(rgArgs: string[]): Promise<{ status: number; stdout: string } | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: { status: number; stdout: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(proc);
        resolve(value);
      };
      // No shell: patterns contain regex metacharacters by design.
      const proc = spawn('rg', rgArgs, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      this.inFlight.add(proc);
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {}
        done(null);
      }, GREP_TIMEOUT_MS);

      let stdout = '';
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        // We only ever read the first MAX_GREP_CANDIDATES matches; a symbol
        // that matches thousands of lines shouldn't buffer all of them.
        if (stdout.length > 256_000) {
          try {
            proc.kill('SIGTERM');
          } catch {}
        }
      });
      proc.stderr.resume();
      proc.on('error', () => done(null));
      proc.on('close', (code) => done({ status: code ?? 1, stdout }));
    });
  }

  /// Tier 2. Spawns the CLI, feeds the prompt on stdin, returns the reply
  /// text (or null on failure/timeout).
  private askModel(o: {
    cwd: string;
    args: SymbolLookupArgs;
    symbol: string;
    backend: Backend;
    binary: string;
    model: string;
  }): Promise<string | null> {
    let childArgs: string[];
    try {
      childArgs = buildLookupArgs(o.backend, o.model, {
        effortSupported: o.backend === 'claude' ? claudeSupportsEffort(o.binary) : undefined,
      });
    } catch {
      return Promise.resolve(null);
    }

    const relFile = path.relative(o.cwd, o.args.filePath) || path.basename(o.args.filePath);
    const prompt = buildLookupPrompt({
      symbol: o.symbol,
      relFile,
      line: o.args.line,
      contextLines: readContext(o.args.filePath, o.args.line),
    });

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(proc);
        resolve(value);
      };

      const proc = spawn(o.binary, childArgs, {
        cwd: o.cwd,
        env: buildBackendEnv(process.env, o.binary),
        shell: backendNeedsShell(o.binary),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.inFlight.add(proc);

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {}
        done(null);
      }, MODEL_TIMEOUT_MS);

      let stdout = '';
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        // A well-behaved reply is a few dozen bytes. Anything runaway is
        // the model ignoring the contract; stop reading it.
        if (stdout.length > 64_000) {
          try {
            proc.kill('SIGTERM');
          } catch {}
        }
      });
      // Drain stderr so a chatty CLI can't fill the pipe buffer and wedge.
      proc.stderr.resume();
      proc.on('error', () => done(null));
      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) return done(null);
        // codex exec wraps its answer in a banner + token footer;
        // extractReviewerDisplay already knows how to strip both.
        done(extractReviewerDisplay(stdout, o.backend) || stdout);
      });

      proc.stdin.on('error', () => done(null));
      proc.stdin.end(prompt, 'utf-8');
    });
  }
}

/// A few lines either side of the click, to give the model the receiver's
/// declared type and the enclosing signature.
function readContext(filePath: string, line: number, radius = 6): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const lo = Math.max(0, line - 1 - radius);
    const hi = Math.min(lines.length, line + radius);
    return lines
      .slice(lo, hi)
      .map((text, i) => `${lo + i + 1}: ${text}`)
      .join('\n');
  } catch {
    return '(unavailable)';
  }
}

function dedupe(candidates: SymbolCandidate[]): SymbolCandidate[] {
  const seen = new Set<string>();
  const out: SymbolCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.absolutePath}:${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
