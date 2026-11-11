// APIs overapi hands over for the org — see src/shared/overapiProject.ts.
//
// The same road as overdb's connections (overdbInbox.ts), in a folder of its
// own: `~/.overcli/inbox/apis/`. Making it is how overapi learns this app
// can take APIs, so `start` makes it even when nobody is signed in to an
// org yet.
//
// Each file is pushed to the org's server as it arrives:
//
//   landed            → `done/`
//   the server said no (bad project, not allowed)
//                     → `rejected/`, with the reason beside it
//   no org yet, signed out, the server unreachable
//                     → stays put, and is pushed again on the next sign-in,
//                       the next file, or the next launch
//
// The person already pressed Publish in overapi, so nothing here asks again.
//
// Electron-free, so a test drives it against a temp dir with a fake push.

import fs from 'node:fs';
import path from 'node:path';

import { API_PUSH_MAX_BYTES, parseApiPush, type ApiPush } from '../shared/overapiProject';
import { defaultInboxDir } from './handoffInbox';
import type { PushOutcome } from './overdbInbox';

export type { PushOutcome };

export function defaultApisDir(): string {
  return path.join(defaultInboxDir(), 'apis');
}

export interface ApisInboxEvents {
  pushed(push: ApiPush, message: string): void;
  /// Waiting on something the person has to do — sign in, mostly.
  waiting(push: ApiPush, error: string): void;
  rejected(name: string, reason: string): void;
}

const RESCAN_DEBOUNCE_MS = 150;
/// Same as the connections inbox: long enough to look back, short enough not to grow forever.
export const APIS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ApisInbox {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /// Files being pushed right now, so a rescan mid-push does not send twice.
  private inFlight = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly push: (push: ApiPush) => Promise<PushOutcome>,
    private readonly events: ApisInboxEvents,
  ) {}

  start(): void {
    for (const sub of ['', 'done', 'rejected']) fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
    this.purge();
    void this.scan();
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => this.scheduleScan());
      this.watcher.on('error', () => this.closeWatcher());
    } catch {
      this.watcher = null;
    }
  }

  /// After a sign-in: whatever was waiting on one goes now.
  retry(): Promise<void> {
    return this.scan();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeWatcher();
  }

  purge(now = Date.now(), maxAgeMs = APIS_RETENTION_MS): void {
    for (const sub of ['done', 'rejected']) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(this.dir, sub));
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(this.dir, sub, name);
        try {
          const stat = fs.lstatSync(full);
          if (!stat.isDirectory() && now - stat.mtimeMs >= maxAgeMs) fs.unlinkSync(full);
        } catch {
          // Not ours to remove, or gone already.
        }
      }
    }
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleScan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan();
    }, RESCAN_DEBOUNCE_MS);
  }

  /// Exposed for tests. Pushes one file at a time, oldest first: an API
  /// published twice arrives in the order it was published, so the newer
  /// one is what the admin sees.
  async scan(): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.startsWith('.') || this.inFlight.has(name)) continue;
      const full = path.join(this.dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      // Never follow a link out of the folder.
      if (!stat.isFile()) continue;
      if (stat.size > API_PUSH_MAX_BYTES) {
        this.reject(name, `larger than ${API_PUSH_MAX_BYTES} bytes`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
      } catch {
        this.reject(name, 'not valid JSON');
        continue;
      }
      const parsed = parseApiPush(raw);
      if (!parsed.ok) {
        this.reject(name, parsed.reason);
        continue;
      }
      this.inFlight.add(name);
      try {
        const res = await this.push(parsed.push);
        if (res.ok) {
          this.moveTo('done', name);
          this.events.pushed(parsed.push, res.message);
        } else if (res.retry) {
          this.events.waiting(parsed.push, res.error);
          // Everything after it is waiting on the same thing.
          return;
        } else {
          this.reject(name, res.error);
        }
      } finally {
        this.inFlight.delete(name);
      }
    }
  }

  private reject(name: string, reason: string): void {
    this.moveTo('rejected', name);
    try {
      fs.writeFileSync(path.join(this.dir, 'rejected', `${name}.reason.txt`), `${reason}\n`);
    } catch {
      // The move is what matters; the note is a courtesy.
    }
    this.events.rejected(name, reason);
  }

  private moveTo(sub: 'done' | 'rejected', name: string): void {
    const dest = path.join(this.dir, sub, name);
    try {
      // Made here as well as in start: a pushed file that could not be moved
      // would be pushed again on every scan.
      fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
      fs.renameSync(path.join(this.dir, name), dest);
      const now = new Date();
      fs.lutimesSync(dest, now, now);
    } catch {
      // Gone already, or the stamp failed and it simply ages from when it was sent.
    }
  }
}
