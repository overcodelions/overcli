// Which files did that shell command change?
//
// Edit and Write carry their diff in their own input, so the transcript can
// show it without asking anyone. A command carries nothing: `sed -i`, a
// heredoc'd Python script, `npm version` — the edit happens and all the
// transcript has is the script. In bypass mode the model is told it may make
// small edits that way, so the most permissive mode is exactly the one where
// the diff cards go missing.
//
// So we measure instead. At the start of a turn, and after every tool result
// that might have written something, the whole working tree is snapshotted
// into a git tree object — through a throwaway index, so the user's real
// index and stash are never touched. When a shell command's result arrives,
// the tree before it is diffed against the tree after it, and the changed
// files ride along on the result as `fileChanges`.
//
// It is attribution by timing, so it is only as precise as the window:
// anything else that writes to the tree while the command runs (the user in
// their editor, a second command running in parallel) lands on the command
// too. Ignored files are invisible to it, which is also what keeps a build
// or an `npm install` from burying the card.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandFileChange, StreamEvent, ToolResultBlock, UUID } from '../shared/types';
import { runGitAsync } from './git';
import { host } from './host';
import { log } from './diagnostics';

/// Tool names that run arbitrary commands. Every backend's parser maps its
/// own shell call onto `Bash`.
const SHELL_TOOLS = new Set(['Bash']);

/// Tools that cannot write to the tree. A result from one of these doesn't
/// need a fresh snapshot — the baseline is still good — which matters
/// because a turn is mostly reads.
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
  'AskUserQuestion',
  'ExitPlanMode',
]);

const MAX_FILES = 40;
const MAX_PATCH_BYTES_PER_FILE = 64 * 1024;
const MAX_PATCH_BYTES_TOTAL = 256 * 1024;
/// A snapshot hashes every changed or untracked file. On a sane repo that is
/// tens of milliseconds; the bound is for the repo with a 2GB untracked
/// dataset in it, where we would rather show nothing than stall the queue.
const SNAPSHOT_TIMEOUT_MS = 15_000;
/// Tool ids remembered per conversation on disk. Old turns age out.
const MAX_STORED_RESULTS = 300;

export interface TreeSnapshot {
  root: string;
  tree: string;
}

/// Write the working tree — tracked and untracked, minus ignored — into the
/// object store and return its tree id. Null when `cwd` isn't in a repo or
/// git fails; callers treat that as "can't say" and show nothing.
export async function snapshotTree(cwd: string): Promise<TreeSnapshot | null> {
  const where = await runGitAsync(['rev-parse', '--show-toplevel', '--absolute-git-dir'], cwd, undefined, 5_000);
  if (where.exitCode !== 0) return null;
  const [root, gitDir] = where.stdout.trim().split('\n');
  if (!root || !gitDir) return null;
  const tmpIndex = path.join(os.tmpdir(), `overcli-snapshot-${randomUUID()}.index`);
  try {
    // Seed from the real index so `add` can trust its stat cache and only
    // hash what actually changed. A missing index (fresh repo) or one git
    // can't read from here (split index) just means a slower first pass.
    let seeded = false;
    try {
      await fs.promises.copyFile(path.join(gitDir, 'index'), tmpIndex);
      seeded = true;
    } catch {
      // No index to seed from.
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    let add = await runGitAsync(['add', '-A', '--', '.'], root, env, SNAPSHOT_TIMEOUT_MS);
    if (add.exitCode !== 0 && seeded) {
      await fs.promises.rm(tmpIndex, { force: true });
      add = await runGitAsync(['add', '-A', '--', '.'], root, env, SNAPSHOT_TIMEOUT_MS);
    }
    if (add.exitCode !== 0) return null;
    const tree = await runGitAsync(['write-tree'], root, env, SNAPSHOT_TIMEOUT_MS);
    if (tree.exitCode !== 0) return null;
    return { root, tree: tree.stdout.trim() };
  } finally {
    void fs.promises.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/// Per-file changes between two snapshot trees, with a capped patch each.
export async function diffTrees(root: string, before: string, after: string): Promise<CommandFileChange[]> {
  if (before === after) return [];
  const base = ['-c', 'core.quotepath=off', 'diff', '--no-renames', '--no-color', '--no-ext-diff'];
  const [nameStatus, numstat] = await Promise.all([
    runGitAsync([...base, '--name-status', '-z', before, after], root),
    runGitAsync([...base, '--numstat', '-z', before, after], root),
  ]);
  if (nameStatus.exitCode !== 0 || numstat.exitCode !== 0) return [];

  const statusByPath = new Map<string, CommandFileChange['status']>();
  const ns = nameStatus.stdout.split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const code = ns[i];
    const file = ns[i + 1];
    if (!file) continue;
    statusByPath.set(file, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
  }

  // `-z` numstat: "adds\tdels\tpath\0". Binaries report `-` for both.
  const changes: Array<CommandFileChange & { binary: boolean }> = [];
  for (const rec of numstat.stdout.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(rec);
    if (!m) continue;
    const file = m[3];
    changes.push({
      path: path.join(root, file),
      relPath: file,
      status: statusByPath.get(file) ?? 'modified',
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-',
    });
    if (changes.length >= MAX_FILES) break;
  }

  let budget = MAX_PATCH_BYTES_TOTAL;
  const patches = await Promise.all(
    changes.map((c) =>
      c.binary
        ? Promise.resolve('')
        : runGitAsync(
            [...base, '--src-prefix=a/', '--dst-prefix=b/', before, after, '--', `:(literal)${c.relPath}`],
            root,
          ).then((r) => (r.exitCode === 0 ? hunksOnly(r.stdout) : '')),
    ),
  );
  return changes.map(({ binary: _binary, ...c }, i) => {
    const patch = patches[i];
    if (!patch || patch.length > MAX_PATCH_BYTES_PER_FILE || patch.length > budget) return c;
    budget -= patch.length;
    return { ...c, patch };
  });
}

/// Drop the `diff --git` / `index` / `---` / `+++` preamble: the card already
/// names the file, and the renderer would print the header lines as labels.
function hunksOnly(patch: string): string {
  const start = patch.startsWith('@@') ? 0 : patch.indexOf('\n@@') + 1;
  if (start <= 0 && !patch.startsWith('@@')) return '';
  return patch.slice(start).replace(/\n$/, '');
}

/// The changes attached to each shell result, kept per conversation so a
/// reopened transcript — rebuilt from the CLI's own log, which knows nothing
/// about them — still shows the diffs.
export class CommandChangeStore {
  private cache = new Map<UUID, Record<string, CommandFileChange[]>>();

  constructor(private dir: () => string = () => path.join(host().dataDir(), 'command-changes')) {}

  private file(convId: UUID): string {
    return path.join(this.dir(), `${convId.replace(/[^0-9a-zA-Z-]/g, '')}.json`);
  }

  load(convId: UUID): Record<string, CommandFileChange[]> {
    const hit = this.cache.get(convId);
    if (hit) return hit;
    let loaded: Record<string, CommandFileChange[]> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(convId), 'utf-8'));
      if (parsed && typeof parsed.byToolUse === 'object') loaded = parsed.byToolUse;
    } catch {
      // Nothing recorded yet.
    }
    this.cache.set(convId, loaded);
    return loaded;
  }

  save(convId: UUID, toolUseId: string, changes: CommandFileChange[]): void {
    const byToolUse = { ...this.load(convId), [toolUseId]: changes };
    const ids = Object.keys(byToolUse);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_STORED_RESULTS))) delete byToolUse[old];
    this.cache.set(convId, byToolUse);
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      const target = this.file(convId);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, byToolUse }));
      fs.renameSync(tmp, target);
    } catch (err) {
      log('warn', 'commandChanges', `could not save changes for ${convId}: ${(err as Error).message}`);
    }
  }

  /// Put recorded changes back onto replayed results.
  apply(convId: UUID, events: StreamEvent[]): StreamEvent[] {
    const byToolUse = this.load(convId);
    if (Object.keys(byToolUse).length === 0) return events;
    return events.map((e) => {
      if (e.kind.type !== 'toolResult' || !e.kind.results.some((r) => byToolUse[r.id])) return e;
      return {
        ...e,
        kind: {
          type: 'toolResult',
          results: e.kind.results.map((r) => (byToolUse[r.id] ? { ...r, fileChanges: byToolUse[r.id] } : r)),
        },
      };
    });
  }
}

interface ConvState {
  cwd: string;
  baseline: TreeSnapshot | null;
  queue: Promise<void>;
  /// Every tool call seen this turn, by id, so a result can be told apart
  /// as a shell call, a read, or something that might have written.
  toolNames: Map<string, string>;
}

/// Watches a conversation's stream and attaches `fileChanges` to the results
/// of shell commands. Snapshots run strictly in order per conversation —
/// each one is the next one's baseline.
export class CommandChangeTracker {
  private convs = new Map<UUID, ConvState>();

  constructor(
    /// Re-send a result event with the changes on it. Same id, so the
    /// renderer replaces the row in place.
    private update: (convId: UUID, event: StreamEvent) => void,
    readonly store = new CommandChangeStore(),
    private snapshot: (cwd: string) => Promise<TreeSnapshot | null> = snapshotTree,
    private diff: typeof diffTrees = diffTrees,
  ) {}

  /// A turn is about to start in `cwd`: take the baseline the first
  /// command's diff is measured from.
  beginTurn(convId: UUID, cwd: string): void {
    const prev = this.convs.get(convId);
    const s: ConvState = {
      cwd,
      baseline: null,
      queue: prev?.queue ?? Promise.resolve(),
      toolNames: new Map(),
    };
    this.convs.set(convId, s);
    this.enqueue(s, async () => {
      s.baseline = await this.snapshot(cwd);
    });
  }

  forget(convId: UUID): void {
    this.convs.delete(convId);
  }

  observe(convId: UUID, events: StreamEvent[]): void {
    const s = this.convs.get(convId);
    if (!s) return;
    for (const e of events) {
      if (e.reviewer) continue;
      if (e.kind.type === 'assistant') {
        for (const use of e.kind.info.toolUses) s.toolNames.set(use.id, use.name);
      } else if (e.kind.type === 'patchApply') {
        // A codex patch is already shown as its own diff. Move the baseline
        // past it so the next command isn't blamed for it.
        this.enqueue(s, async () => {
          s.baseline = await this.snapshot(s.cwd);
        });
      } else if (e.kind.type === 'toolResult') {
        // Our own re-send of a result we already handled.
        if (e.kind.results.some((r) => r.fileChanges)) continue;
        const results = e.kind.results;
        const target = results.find((r) => SHELL_TOOLS.has(s.toolNames.get(r.id) ?? ''));
        const mightHaveWritten = results.some((r) => !READ_ONLY_TOOLS.has(s.toolNames.get(r.id) ?? ''));
        if (!mightHaveWritten) continue;
        const event = e;
        this.enqueue(s, () => this.measure(convId, s, event, target));
      }
    }
  }

  private async measure(
    convId: UUID,
    s: ConvState,
    event: StreamEvent,
    target: ToolResultBlock | undefined,
  ): Promise<void> {
    const before = s.baseline;
    const after = await this.snapshot(s.cwd);
    s.baseline = after;
    if (!target || !before || !after || before.root !== after.root || before.tree === after.tree) return;
    const changes = await this.diff(after.root, before.tree, after.tree);
    if (changes.length === 0 || event.kind.type !== 'toolResult') return;
    this.store.save(convId, target.id, changes);
    this.update(convId, {
      ...event,
      kind: {
        type: 'toolResult',
        results: event.kind.results.map((r) => (r.id === target.id ? { ...r, fileChanges: changes } : r)),
      },
    });
  }

  private enqueue(s: ConvState, fn: () => Promise<void>): void {
    s.queue = s.queue.then(fn).catch((err) => {
      log('warn', 'commandChanges', `snapshot failed: ${(err as Error).message}`);
    });
  }

  /// Settles once every queued snapshot for the conversation has run. Tests.
  idle(convId: UUID): Promise<void> {
    return this.convs.get(convId)?.queue ?? Promise.resolve();
  }
}
