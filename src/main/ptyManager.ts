// Shells running inside the app's terminal drawer.
//
// The PTY lives here in main and the renderer only ever sees bytes: it asks
// for a shell in a folder, writes keystrokes, and is told what came out. That
// keeps node-pty (a native module) and the user's shell out of the renderer
// entirely, the same seam every other process this app starts goes through.
//
// Output is batched per terminal before it crosses IPC. A `cat` of a big file
// or a noisy build produces thousands of tiny chunks a second, and one IPC
// message per chunk is what makes an embedded terminal feel slower than the
// real one. A frame's worth of coalescing is invisible to a person typing.
//
// Each terminal also keeps a bounded tail of its output, so a drawer that was
// closed (or a renderer that reloaded) can repaint what was there instead of
// coming back to a blank screen over a shell that is still running.
//
// Free of Electron so it can be unit-tested with a fake spawner.

import type { TerminalSession } from '../shared/types';

/// The slice of node-pty this module uses, so tests can hand in a fake.
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess;

export type PtyEvent =
  | { type: 'terminalData'; id: string; data: string }
  | { type: 'terminalExit'; id: string; exitCode: number };

/// How long output may sit before it is sent: about one frame.
const FLUSH_MS = 16;
/// A starting shell has drawn its prompt once it has printed something and
/// then gone quiet this long.
const PROMPT_QUIET_MS = 150;
/// Typed anyway after this, for a shell whose rc files never stop talking.
const PROMPT_DEADLINE_MS = 5_000;
/// The tail kept for repainting. Enough for a few screens of a build log,
/// small enough that a dozen open terminals cost nothing worth measuring.
const SCROLLBACK_CHARS = 256 * 1024;

/// Set by the app, not the user's shell, and wrong for anything the user
/// starts: the first turns every node in the shell into plain node.
const DROPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'VITE_DEV_SERVER_URL'];

interface Entry {
  session: TerminalSession;
  proc: PtyProcess;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  tail: string;
  /// A command waiting for the shell's first prompt (see `create`).
  startup: Startup | null;
}

interface Startup {
  command: string;
  quiet: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout>;
}

export interface PtyManagerOptions {
  spawn: PtySpawn;
  emit: (event: PtyEvent) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export class PtyManager {
  private readonly entries = new Map<string, Entry>();
  private nextId = 1;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: PtyManagerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
  }

  /// Starts a shell. `command` is typed into it once the shell is ready for
  /// input — not straight away: bash and zsh both drop typeahead that arrives
  /// while their rc files are still running, so a command written at spawn
  /// is echoed and then silently lost. Typing it (rather than running it in
  /// place of the shell) leaves a prompt behind when it exits, as a Terminal
  /// window would.
  create(args: { cwd: string; cols: number; rows: number; command?: string }): TerminalSession {
    const { file, argv } = defaultShell(this.platform, this.env);
    const proc = this.opts.spawn(file, argv, {
      name: 'xterm-256color',
      cols: clampSize(args.cols, 80),
      rows: clampSize(args.rows, 24),
      cwd: args.cwd,
      env: shellEnvironment(this.env, this.platform),
    });
    const id = `t${this.nextId++}`;
    const session: TerminalSession = {
      id,
      cwd: args.cwd,
      shell: shellName(file),
      pid: proc.pid,
      exitCode: null,
    };
    const entry: Entry = { session, proc, pending: '', timer: null, tail: '', startup: null };
    if (args.command) {
      entry.startup = {
        command: args.command,
        quiet: null,
        deadline: setTimeout(() => this.typeStartup(entry), PROMPT_DEADLINE_MS),
      };
    }
    this.entries.set(id, entry);
    proc.onData((data) => this.onData(entry, data));
    proc.onExit(({ exitCode }) => {
      this.flush(entry);
      entry.session = { ...entry.session, exitCode };
      this.opts.emit({ type: 'terminalExit', id, exitCode });
    });
    return session;
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.session.exitCode !== null) return;
    entry.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.session.exitCode !== null) return;
    // A drawer collapsed to nothing measures zero rows; node-pty throws on
    // that, and the shell has nothing useful to do with it anyway.
    if (!(cols >= 2 && rows >= 1)) return;
    try {
      entry.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {
      // The process went away between the check and the call.
    }
  }

  /// What the terminal has printed recently, for repainting a fresh view.
  /// Anything still pending is sent first, so a view can treat every event
  /// that reached it before this answer as already included here.
  snapshot(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.flush(entry);
    return entry.tail;
  }

  list(): TerminalSession[] {
    return [...this.entries.values()].map((e) => e.session);
  }

  /// Ends the shell (if still running) and forgets the terminal.
  close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.startup) {
      clearTimeout(entry.startup.deadline);
      if (entry.startup.quiet) clearTimeout(entry.startup.quiet);
      entry.startup = null;
    }
    if (entry.session.exitCode === null) {
      try {
        entry.proc.kill();
      } catch {
        // Already gone.
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private typeStartup(entry: Entry): void {
    const startup = entry.startup;
    if (!startup) return;
    entry.startup = null;
    clearTimeout(startup.deadline);
    if (startup.quiet) clearTimeout(startup.quiet);
    if (this.entries.get(entry.session.id) !== entry || entry.session.exitCode !== null) return;
    entry.proc.write(`${startup.command}\r`);
  }

  private onData(entry: Entry, data: string): void {
    const startup = entry.startup;
    if (startup) {
      if (startup.quiet) clearTimeout(startup.quiet);
      startup.quiet = setTimeout(() => this.typeStartup(entry), PROMPT_QUIET_MS);
    }
    entry.pending += data;
    entry.timer ??= setTimeout(() => this.flush(entry), FLUSH_MS);
  }

  private flush(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.pending) return;
    const data = entry.pending;
    entry.pending = '';
    entry.tail = trimTail(entry.tail + data);
    // Closed terminals stay quiet: the renderer already dropped the view.
    if (this.entries.get(entry.session.id) !== entry) return;
    this.opts.emit({ type: 'terminalData', id: entry.session.id, data });
  }
}

/// The user's own shell, started as a login shell so it reads the same
/// profile a Terminal window would — a Mac app launched from the Dock has none
/// of that in its own environment.
export function defaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; argv: string[] } {
  if (platform === 'win32') {
    return { file: env.COMSPEC && /powershell|pwsh/i.test(env.COMSPEC) ? env.COMSPEC : 'powershell.exe', argv: [] };
  }
  const file = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { file, argv: ['-l'] };
}

export function shellEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || DROPPED_ENV.includes(k)) continue;
    out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'Overcli';
  // Colour from `ls` and the other BSD tools on macOS, which stay plain unless
  // asked. A user who set it either way keeps their own choice.
  out.CLICOLOR ??= '1';
  // macOS's bash prints a "default shell is now zsh" notice on every start;
  // in a drawer that opens often, it is noise above every prompt.
  if (platform === 'darwin') out.BASH_SILENCE_DEPRECATION_WARNING = '1';
  // Login shells on macOS start in $HOME unless told otherwise by the cwd,
  // which node-pty already sets; a stale PWD from the app's own launch would
  // make `pwd -L` lie about it.
  delete out.PWD;
  delete out.OLDPWD;
  if (!out.LANG && platform !== 'win32') out.LANG = 'en_US.UTF-8';
  return out;
}

function shellName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.exe$/i, '');
}

function clampSize(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 1000);
}

function trimTail(tail: string): string {
  if (tail.length <= SCROLLBACK_CHARS) return tail;
  // Cut at a line break so the repaint doesn't start mid-escape-sequence.
  const cut = tail.length - SCROLLBACK_CHARS;
  const nl = tail.indexOf('\n', cut);
  return tail.slice(nl >= 0 ? nl + 1 : cut);
}
