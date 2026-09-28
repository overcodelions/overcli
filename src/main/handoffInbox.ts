// The inbox other tools drop work into — see src/shared/handoff.ts for the
// format and why it is a folder.
//
// The folder is the state. A pending handoff is a file in the inbox; handled
// ones move to `done/`, unreadable ones to `rejected/` next to a note saying
// why. There is no index to fall out of step with the files, and a person can
// look in the folder and see exactly what overcli sees.
//
// Fixed at `~/.overcli/inbox` rather than under the data directory: the
// sender has to find it without asking, and the data directory moves between
// dev and packaged builds. Worktrees already live under `~/.overcli` for the
// same reason.
//
// Electron-free, so a test drives it against a temp dir.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HANDOFF_MAX_BYTES, parseHandoff, type InboundHandoff } from '../shared/handoff';

export function defaultInboxDir(): string {
  return path.join(os.homedir(), '.overcli', 'inbox');
}

/// A burst of writes — a sender dropping three at once, or tmp + rename —
/// lands as one rescan.
const RESCAN_DEBOUNCE_MS = 150;

export class HandoffInbox {
  private pending = new Map<string, { file: string; handoff: InboundHandoff }>();
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onChange: (items: InboundHandoff[]) => void,
  ) {}

  /// Create the folders, read what arrived while overcli was closed, and
  /// watch for more. A folder that cannot be watched still gets its startup
  /// scan: the inbox degrades to "checked at launch", never to broken.
  start(): void {
    for (const sub of ['', 'done', 'rejected']) {
      fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
    }
    this.scan();
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => this.scheduleScan());
      this.watcher.on('error', () => this.closeWatcher());
    } catch {
      this.watcher = null;
    }
  }

  list(): InboundHandoff[] {
    return [...this.pending.values()]
      .map((p) => p.handoff)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /// Handled — started as a conversation or dismissed. Moved, not deleted,
  /// so what came in stays inspectable.
  resolve(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    try {
      fs.renameSync(path.join(this.dir, entry.file), path.join(this.dir, 'done', entry.file));
    } catch {
      // Already gone (the sender withdrew it, or a second window beat us).
      // Either way it is no longer pending.
    }
    this.pending.delete(id);
    this.onChange(this.list());
    return true;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeWatcher();
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleScan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan();
    }, RESCAN_DEBOUNCE_MS);
  }

  /// Exposed for tests, which should not have to wait on fs.watch.
  scan(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const next = new Map<string, { file: string; handoff: InboundHandoff }>();
    for (const name of names.sort()) {
      // `.tmp` is a sender mid-write; dotfiles are Finder's.
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const full = path.join(this.dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      // Never follow a link out of the inbox: a symlink to some other file
      // would have us read, and draw, whatever it points at.
      if (!stat.isFile()) continue;
      if (stat.size > HANDOFF_MAX_BYTES) {
        this.reject(name, `larger than ${HANDOFF_MAX_BYTES} bytes`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
      } catch {
        this.reject(name, 'not valid JSON');
        continue;
      }
      const parsed = parseHandoff(raw);
      if (!parsed.ok) {
        this.reject(name, parsed.reason);
        continue;
      }
      // A resend of one already waiting is the same piece of work.
      if (next.has(parsed.handoff.id)) {
        this.moveTo('done', name);
        continue;
      }
      next.set(parsed.handoff.id, { file: name, handoff: parsed.handoff });
    }
    const changed =
      next.size !== this.pending.size || [...next.keys()].some((id) => !this.pending.has(id));
    this.pending = next;
    if (changed) this.onChange(this.list());
  }

  private reject(name: string, reason: string): void {
    this.moveTo('rejected', name);
    try {
      fs.writeFileSync(path.join(this.dir, 'rejected', `${name}.reason.txt`), `${reason}\n`);
    } catch {
      // The move is what matters; the note is a courtesy.
    }
  }

  private moveTo(sub: 'done' | 'rejected', name: string): void {
    try {
      fs.renameSync(path.join(this.dir, name), path.join(this.dir, sub, name));
    } catch {
      // Gone already.
    }
  }
}
