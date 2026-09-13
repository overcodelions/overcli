// Who is holding the port, and letting go of it.
//
// A service overcli started outlives overcli when the app is killed rather
// than quit — which is exactly what happens in development, and what happened
// to the person who asked for this. The next start then fails with "port 3000
// is already taken by another program", which is true and useless: the program
// is a `node` from twenty minutes ago that nobody can find without knowing
// `lsof`.
//
// So: name it, and offer to stop it. Both are deliberately explicit — nothing
// here kills anything without being asked, because the process on that port
// might be someone's editor, their database, or work they care about.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { PortHolderKind } from '../../shared/services';

export interface PortOwner {
  pid: number;
  /// The executable's name — `node`, `java`, `docker`. Short, because that is
  /// what `lsof` reports and what a person recognises.
  command: string;
  /// What it is to us — see `classifyOwner`. Absent when nobody asked.
  kind?: PortHolderKind;
}

/// What the lookup knows about the service asking.
export interface OwnerContext {
  /// overcli's own checkout, in development only. A process working there is
  /// overcli's dev tooling — its vite, its tsc — and stopping it takes down
  /// the app doing the asking.
  appRoot?: string;
  /// The checkout the service runs from.
  servicePath?: string;
}

/// Enough of the process table to tell who started whom, and where.
export interface ProcessFacts {
  selfPid: number;
  parents: ReadonlyMap<number, number>;
  cwds: ReadonlyMap<number, string>;
}

function within(dir: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, '');
  return dir === base || dir.startsWith(base + path.sep) || dir.startsWith(`${base}/`);
}

function descends(pid: number, ancestor: number, parents: ReadonlyMap<number, number>): boolean {
  let at = parents.get(pid);
  for (let guard = 0; at !== undefined && at > 1 && guard < 64; guard++) {
    if (at === ancestor) return true;
    at = parents.get(at);
  }
  return false;
}

/// Which of three things a port holder is, because each wants a different
/// sentence and only one of them is safe to offer to stop:
///
/// - `self`: overcli, or its own dev server. The screenshot that prompted this
///   blamed overcli's vite on 5173 for a service that never used 5173, and
///   offered to stop it.
/// - `stale`: a copy of this service whose launcher has exited — its topmost
///   process still working in the checkout has been handed to launchd (pid 1).
///   That is what a `concurrently` killed mid-run leaves behind.
/// - `other`: anything else, including this service run from a terminal, which
///   is someone's live work.
export function classifyOwner(pid: number, ctx: OwnerContext, facts: ProcessFacts): PortHolderKind {
  if (pid === facts.selfPid) return 'self';
  // Something overcli launched is a service, not overcli.
  if (descends(pid, facts.selfPid, facts.parents)) return 'other';

  const cwd = facts.cwds.get(pid);
  if (!cwd) return 'other';
  const inService = ctx.servicePath !== undefined && within(cwd, ctx.servicePath);
  if (ctx.appRoot && within(cwd, ctx.appRoot) && !inService) return 'self';
  if (!inService) return 'other';

  let top = pid;
  for (let guard = 0; guard < 64; guard++) {
    const parent = facts.parents.get(top);
    if (parent === undefined || parent <= 1) break;
    const parentCwd = facts.cwds.get(parent);
    if (!parentCwd || !within(parentCwd, ctx.servicePath!)) break;
    top = parent;
  }
  return facts.parents.get(top) === 1 ? 'stale' : 'other';
}

/// One kind for a set of holders. Any `self` wins, because offering to stop
/// several processes of which one is overcli is still offering to stop overcli.
export function holderKind(owners: readonly PortOwner[]): PortHolderKind | undefined {
  if (owners.length === 0) return undefined;
  if (owners.some((o) => o.kind === 'self')) return 'self';
  if (owners.every((o) => o.kind === 'stale')) return 'stale';
  return 'other';
}

/// `ps -axo pid=,ppid=` as a child → parent map.
export function parsePsParents(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) out.set(Number(match[1]), Number(match[2]));
  }
  return out;
}

/// `lsof -a -d cwd -p … -Fpn` as pid → working directory.
export function parseLsofCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isNaN(parsed) ? null : parsed;
    } else if (line.startsWith('n') && pid !== null && !out.has(pid)) {
      out.set(pid, line.slice(1));
    }
  }
  return out;
}

/// The parents and working directories of these pids and their ancestors.
/// Unix only; empty maps read as "cannot tell", which classifies as `other`.
function processFacts(pids: readonly number[]): ProcessFacts {
  const parents = parsePsParents(run('ps', ['-axo', 'pid=,ppid=']) ?? '');
  const wanted = new Set<number>();
  for (const pid of pids) {
    let at: number | undefined = pid;
    for (let guard = 0; at !== undefined && at > 1 && guard < 64; guard++) {
      wanted.add(at);
      at = parents.get(at);
    }
  }
  const cwds =
    wanted.size === 0
      ? new Map<number, string>()
      : parseLsofCwds(run('lsof', ['-a', '-d', 'cwd', '-p', [...wanted].join(','), '-Fpn']) ?? '');
  return { selfPid: process.pid, parents, cwds };
}

/// Parse `lsof -Fpc` field output.
///
/// The field format is one letter per line: `p` starts a process record, `c`
/// is its command, and everything else (file descriptors, names) belongs to
/// whichever process was named last. Parsing this rather than the human table
/// avoids guessing at column widths for a command with a space in it.
export function parseLsofFields(text: string): PortOwner[] {
  const out: PortOwner[] = [];
  let pid: number | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isNaN(parsed) ? null : parsed;
      continue;
    }
    if (line.startsWith('c') && pid !== null) {
      // A process can list several files on the port; it is one holder.
      if (!out.some((o) => o.pid === pid)) out.push({ pid, command: line.slice(1) });
    }
  }
  return out;
}

/// Parse `ss -ltnpH` output. The process is in a `users:(("java",pid=123,fd=4))`
/// column, present only for sockets the caller is allowed to see — a line
/// without one is a listener owned by someone else, and names nobody.
export function parseSsListeners(text: string): PortOwner[] {
  const out: PortOwner[] = [];
  for (const match of text.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)) {
    const pid = Number.parseInt(match[2], 10);
    if (!out.some((o) => o.pid === pid)) out.push({ pid, command: match[1] });
  }
  return out;
}

/// Pids listening on `port` in `netstat -ano` output.
///
/// The state column is translated on a non-English Windows ("ABHÖREN"), so a
/// listener is recognised by its foreign address instead: `0.0.0.0:0` or
/// `[::]:0` means nothing is connected, which only a listening socket has.
export function parseNetstatListeners(text: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 5 || parts[0].toUpperCase() !== 'TCP') continue;
    const [, local, foreign, , pidText] = parts;
    if (!local.endsWith(`:${port}`) || !foreign.endsWith(':0')) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isNaN(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/// The image name from one `tasklist /FO CSV /NH` row: `"java.exe","1234",…`.
export function parseTasklistName(text: string): string | null {
  const match = /^"([^"]*)"/.exec(text.trim());
  return match ? match[1] : null;
}

/// Run a lookup tool, or null when it is missing or refused. lsof also exits
/// non-zero when nothing matches, which is the common case and reads the same.
function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function windowsOwners(port: number): PortOwner[] {
  const netstat = run('netstat', ['-ano', '-p', 'TCP']);
  const netstat6 = run('netstat', ['-ano', '-p', 'TCPv6']);
  const pids = parseNetstatListeners(`${netstat ?? ''}\n${netstat6 ?? ''}`, port);
  return pids.map((pid) => {
    const row = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return { pid, command: (row && parseTasklistName(row)) || 'unknown' };
  });
}

/// What is listening on a port right now. Empty when nothing is, or when the
/// lookup tool is unavailable — a missing tool must read as "cannot tell",
/// never as "nothing there", because the difference decides whether we offer
/// to kill something.
///
/// Each platform has its own tool: Windows has no lsof, and plenty of Linux
/// installs ship `ss` but not lsof.
export function portOwners(port: number, ctx: OwnerContext = {}): PortOwner[] {
  const owners = listeners(port);
  if (owners.length === 0) return owners;
  if (process.platform === 'win32') {
    return owners.map((o) => ({ ...o, kind: o.pid === process.pid ? 'self' : 'other' }));
  }
  const facts = processFacts(owners.map((o) => o.pid));
  return owners.map((o) => ({ ...o, kind: classifyOwner(o.pid, ctx, facts) }));
}

function listeners(port: number): PortOwner[] {
  if (process.platform === 'win32') return windowsOwners(port);
  if (process.platform === 'linux') {
    const ss = run('ss', ['-ltnpH', `sport = :${port}`]);
    if (ss !== null) return parseSsListeners(ss);
  }
  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  return lsof === null ? [] : parseLsofFields(lsof);
}

/// Ask the processes on a port to stop, then insist.
///
/// SIGTERM first so a server can close its connections; SIGKILL after a grace
/// period for the one that ignores it. Reports what it actually managed to
/// signal rather than claiming success — the process may belong to another
/// user, and "I could not" is a useful answer.
export async function freePort(
  port: number,
  opts: { graceMs?: number; context?: OwnerContext } = {},
): Promise<{ stopped: PortOwner[]; refused: PortOwner[] }> {
  const owners = portOwners(port, opts.context);
  const stopped: PortOwner[] = [];
  const refused: PortOwner[] = [];

  for (const owner of owners) {
    // The pane never offers this, but a stale banner could still ask.
    if (owner.kind === 'self') {
      refused.push(owner);
      continue;
    }
    try {
      process.kill(owner.pid, 'SIGTERM');
      stopped.push(owner);
    } catch {
      // No such process (it exited between the scan and now), or not ours.
      refused.push(owner);
    }
  }

  if (stopped.length === 0) return { stopped, refused };

  await new Promise((resolve) => setTimeout(resolve, opts.graceMs ?? 2_000));

  for (const owner of stopped) {
    try {
      // Signal 0 tests existence without sending anything.
      process.kill(owner.pid, 0);
      process.kill(owner.pid, 'SIGKILL');
    } catch {
      // Already gone, which is what was wanted.
    }
  }

  return { stopped, refused };
}

/// One line naming what is on the port, for the banner that offers to stop it.
export function describeOwners(owners: readonly PortOwner[]): string {
  if (owners.length === 0) return 'another program on this machine';
  if (owners.length === 1) return `${owners[0].command} (pid ${owners[0].pid})`;
  return `${owners.length} processes — ${owners.map((o) => o.command).join(', ')}`;
}
