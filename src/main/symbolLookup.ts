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

/// Declaration-shaped regexes for `symbol`, tuned per language family.
/// These are deliberately biased toward false negatives: a miss falls
/// through to the model tier, whereas a loose pattern that matches every
/// call site makes the grep tier useless (every lookup would look
/// "ambiguous" and pay for a model round trip).
export function declarationPatterns(filePath: string, symbol: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  // `symbol` is identifier-shaped (isSafeSymbol), so it needs no escaping.
  const s = symbol;

  if (ext === '.py' || ext === '.pyi') {
    return [String.raw`^\s*(async\s+)?def\s+${s}\b`, String.raw`^\s*class\s+${s}\b`];
  }
  if (ext === '.rb' || ext === '.rake') {
    return [String.raw`^\s*def\s+(self\.)?${s}\b`, String.raw`^\s*(class|module)\s+${s}\b`];
  }
  if (ext === '.ex' || ext === '.exs') {
    return [String.raw`^\s*def(p|macro)?\s+${s}\b`, String.raw`^\s*defmodule\s+.*${s}\b`];
  }

  // Brace-family default: Java, TS/JS, Go, Rust, C/C++, C#, Kotlin,
  // Swift, PHP, Scala, Dart.
  return [
    // Keyword-introduced definitions: function/def/fn/func/sub.
    String.raw`\b(function|fn|func|sub)\s+${s}\s*[(<]`,
    // Type declarations.
    String.raw`\b(class|interface|struct|enum|trait|record|protocol|type|typealias)\s+${s}\b`,
    // A signature whose body opens on the same line. This is what catches
    // Java/C#/Kotlin/Swift methods, which have no introducer keyword:
    //   public static Foo doThing(Bar b) throws X {
    // Requiring a body-opening token after the parameter list is what
    // keeps `doThing(b);` call sites out.
    String.raw`\b${s}\s*\([^;]*\)\s*(const\s*)?(:\s*[\w<>\[\],.?\s]+)?(throws\s+[\w.,\s]+)?(\{|=>|->)`,
    // JS/TS assigned function or arrow: `const foo = (a) => {`,
    // `foo: async function (`.
    String.raw`\b${s}\s*[:=]\s*(async\s+)?(function\b|\(|<)`,
  ];
}

/// Parse `path:line:text` lines from `rg --no-heading -n`. Absolute paths
/// are relativized against `cwd` so candidates are stable to display.
export function parseGrepMatches(
  stdout: string,
  cwd: string,
): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
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
    out.push({ path: rel, line: lineNo });
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

    const key = `${cwd} ${path.extname(args.filePath).toLowerCase()} ${symbol}`;
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
    const patterns = declarationPatterns(filePath, symbol);
    const rgArgs = ['--no-heading', '-n', '-s', '--max-count', '4'];
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

    const verified = await verifyAll(cwd, parseGrepMatches(res.stdout, cwd), symbol, 'grep');
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
