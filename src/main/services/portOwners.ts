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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import type { PortHolderKind } from '../../shared/services';

export interface PortOwner {
  pid: number;
  /// The executable's name — `node`, `java`, `docker`. Short, because that is
  /// what `lsof` reports and what a person recognises.
  command: string;
  /// What it is to us — see `classifyOwner`. Absent when nobody asked.
  kind?: PortHolderKind;
  /// For a leftover of one of our services: the process overcli launched, at
  /// the top of the tree this one belongs to. Stopping means stopping that
  /// tree, not just the process that answered.
  root?: number;
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

  const top = serviceRoot(pid, ctx.servicePath!, facts);
  return facts.parents.get(top) === 1 ? 'stale' : 'other';
}

/// The highest ancestor of `pid` still working in the checkout — the process
/// overcli actually launched, when it is ours.
///
/// Walks OVER ancestors that are not in the checkout rather than stopping at
/// them. A Gradle service is `java` under a daemon whose cwd is
/// `~/.gradle/daemon/...`, under the `gradlew` overcli spawned; stopping at the
/// first parent outside the checkout stopped at the daemon and called every
/// Gradle service somebody else's. A parent whose cwd cannot be read ends the
/// walk: nothing can be concluded about a process we cannot see.
function serviceRoot(pid: number, servicePath: string, facts: ProcessFacts): number {
  let top = pid;
  let at = pid;
  for (let guard = 0; guard < 64; guard++) {
    const parent = facts.parents.get(at);
    if (parent === undefined || parent <= 1) break;
    const parentCwd = facts.cwds.get(parent);
    if (!parentCwd) break;
    if (within(parentCwd, servicePath)) top = parent;
    at = parent;
  }
  return top;
}

/// A leftover's whole tree hangs off its root, and that is what stopping it
/// has to take down. The listener alone is the app JVM; its daemon and wrapper
/// outlive it, and a portless one found by its wrapper leaves the app JVM
/// behind, still holding whatever it binds — which the next start then hits.
function withRoot(owner: PortOwner, servicePath: string | undefined, facts: ProcessFacts): PortOwner {
  if (owner.kind !== 'stale' || !servicePath) return owner;
  return { ...owner, root: serviceRoot(owner.pid, servicePath, facts) };
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
export type LookupRunner = (command: string, args: string[]) => Promise<string | null>;

async function processFacts(pids: readonly number[], runner: LookupRunner): Promise<ProcessFacts> {
  const parents = parsePsParents((await runner('ps', ['-axo', 'pid=,ppid='])) ?? '');
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
      : parseLsofCwds((await runner('lsof', ['-a', '-d', 'cwd', '-p', [...wanted].join(','), '-Fpn'])) ?? '');
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
const execFileAsync = promisify(execFile);
async function run(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function windowsOwners(port: number, runner: LookupRunner): Promise<PortOwner[]> {
  const netstat = await runner('netstat', ['-ano', '-p', 'TCP']);
  const netstat6 = await runner('netstat', ['-ano', '-p', 'TCPv6']);
  const pids = parseNetstatListeners(`${netstat ?? ''}\n${netstat6 ?? ''}`, port);
  return await Promise.all(pids.map(async (pid) => {
    const row = await runner('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return { pid, command: (row && parseTasklistName(row)) || 'unknown' };
  }));
}

/// What is listening on a port right now. Empty when nothing is, or when the
/// lookup tool is unavailable — a missing tool must read as "cannot tell",
/// never as "nothing there", because the difference decides whether we offer
/// to kill something.
///
/// Each platform has its own tool: Windows has no lsof, and plenty of Linux
/// installs ship `ss` but not lsof.
export async function portOwners(
  port: number,
  ctx: OwnerContext = {},
  runner: LookupRunner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<PortOwner[]> {
  const owners = await listeners(port, runner, platform);
  if (owners.length === 0) return owners;
  if (platform === 'win32') {
    return owners.map((o) => ({ ...o, kind: o.pid === process.pid ? 'self' : 'other' }));
  }
  const facts = await processFacts(owners.map((o) => o.pid), runner);
  return owners.map((o) => ({ ...o, kind: classifyOwner(o.pid, ctx, facts) }));
}

async function listeners(port: number, runner: LookupRunner, platform: NodeJS.Platform): Promise<PortOwner[]> {
  if (platform === 'win32') return windowsOwners(port, runner);
  if (platform === 'linux') {
    const ss = await runner('ss', ['-ltnpH', `sport = :${port}`]);
    if (ss !== null) return parseSsListeners(ss);
  }
  const lsof = await runner('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  return lsof === null ? [] : parseLsofFields(lsof);
}

/// Every listener on the machine from one `lsof -Fpcn` scan, with the port
/// each one holds.
///
/// The `n` field is the address — `*:8088`, `127.0.0.1:5002`, `[::1]:5002` —
/// so the port is what follows the last colon. A process listing the same port
/// on several descriptors is one holder of it.
export function parseLsofListenerPorts(text: string): { pid: number; command: string; port: number }[] {
  const out: { pid: number; command: string; port: number }[] = [];
  let pid: number | null = null;
  let command = '';

  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isNaN(parsed) ? null : parsed;
      command = '';
      continue;
    }
    if (line.startsWith('c')) {
      command = line.slice(1);
      continue;
    }
    if (!line.startsWith('n') || pid === null) continue;
    const port = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
    if (Number.isNaN(port)) continue;
    if (!out.some((o) => o.pid === pid && o.port === port)) out.push({ pid, command, port });
  }
  return out;
}

/// The same, from one `ss -ltnpH` listing. The local address is the fourth
/// column and the process is in a `users:(("java",pid=123,fd=4))` column that
/// is only present for sockets the caller may see.
export function parseSsListenerPorts(text: string): { pid: number; command: string; port: number }[] {
  const out: { pid: number; command: string; port: number }[] = [];
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const port = Number.parseInt(columns[3].slice(columns[3].lastIndexOf(':') + 1), 10);
    if (Number.isNaN(port)) continue;
    for (const match of line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)) {
      const pid = Number.parseInt(match[2], 10);
      if (!out.some((o) => o.pid === pid && o.port === port)) out.push({ pid, command: match[1], port });
    }
  }
  return out;
}

/// Who holds each of these ports, for a whole stack at once.
///
/// One scan, not one per port. A per-port lookup costs a `ps` and two `lsof`s,
/// and twenty-five of them started together time each other out against the
/// three-second budget — and a lookup that times out reports NOTHING LISTENING,
/// which is indistinguishable from an idle port and is how a stack of
/// twenty-five running services came to be adopted as none of them.
///
/// `contextFor` gives each port its own service checkout, since that is what
/// decides whether a holder is ours.
export async function portOwnersFor(
  ports: readonly number[],
  contextFor: (port: number) => OwnerContext,
  runner: LookupRunner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, PortOwner[]>> {
  const wanted = new Set(ports);
  const byPort = new Map<number, PortOwner[]>();
  if (wanted.size === 0) return byPort;

  const found = await allListeners(runner, platform);
  for (const listener of found) {
    if (!wanted.has(listener.port)) continue;
    const owners = byPort.get(listener.port) ?? [];
    if (!owners.some((o) => o.pid === listener.pid)) owners.push({ pid: listener.pid, command: listener.command });
    byPort.set(listener.port, owners);
  }
  if (byPort.size === 0) return byPort;

  const pids = [...new Set([...byPort.values()].flat().map((o) => o.pid))];
  if (platform === 'win32') {
    for (const [port, owners] of byPort) {
      byPort.set(port, owners.map((o) => ({ ...o, kind: o.pid === process.pid ? 'self' : 'other' })));
    }
    return byPort;
  }

  const facts = await processFacts(pids, runner);
  for (const [port, owners] of byPort) {
    const ctx = contextFor(port);
    byPort.set(port, owners.map((o) =>
      withRoot({ ...o, kind: classifyOwner(o.pid, ctx, facts) }, ctx.servicePath, facts)));
  }
  return byPort;
}

async function allListeners(
  runner: LookupRunner,
  platform: NodeJS.Platform,
): Promise<{ pid: number; command: string; port: number }[]> {
  if (platform === 'win32') {
    const netstat = `${(await runner('netstat', ['-ano', '-p', 'TCP'])) ?? ''}\n${
      (await runner('netstat', ['-ano', '-p', 'TCPv6'])) ?? ''
    }`;
    const rows: { pid: number; command: string; port: number }[] = [];
    for (const line of netstat.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 5 || parts[0].toUpperCase() !== 'TCP') continue;
      const [, local, foreign, , pidText] = parts;
      if (!foreign.endsWith(':0')) continue;
      const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 10);
      const pid = Number.parseInt(pidText, 10);
      if (Number.isNaN(port) || Number.isNaN(pid) || pid <= 0) continue;
      if (!rows.some((r) => r.pid === pid && r.port === port)) rows.push({ pid, command: 'unknown', port });
    }
    return rows;
  }
  if (platform === 'linux') {
    const ss = await runner('ss', ['-ltnpH']);
    if (ss !== null) return parseSsListenerPorts(ss);
  }
  const lsof = await runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  return lsof === null ? [] : parseLsofListenerPorts(lsof);
}

/// A process that appears to BE one of our services, found without a port.
export interface ProcessMatch {
  pid: number;
  /// Its full command line, for saying which process was recognised.
  command: string;
  kind?: PortHolderKind;
  /// The top of its tree, as for `PortOwner.root`.
  root?: number;
}

/// Whether a process's command line is this service's.
///
/// The PROGRAM is not required, only the arguments. Launchers replace
/// themselves: `./gradlew` is a script that execs into `java …
/// GradleWrapperMain`, `npm` into `node …/npm-cli.js`, `npx vite` into node —
/// so the word the spec starts with is usually the one word the running
/// process no longer has. Requiring it made every Gradle service invisible,
/// and the guard against a second copy never fired. The arguments survive the
/// exec, and they carry what distinguishes one service from another.
///
/// Matched as whole words, never substrings: `start` must be an argument, not
/// part of `restart-worker`. An argument with spaces in it — `-PjvmArgs=-Da=b
/// -Dc=d` — is one argv element but several words in `ps` output, so each of
/// its words must appear.
export function commandMatches(args: string, tokens: readonly string[]): boolean {
  const words = tokens.slice(1).flatMap((token) => token.split(/\s+/)).filter(Boolean);
  // A bare program with no arguments identifies nothing once the program
  // itself is discounted.
  if (words.length === 0) return false;
  const present = new Set(args.split(/\s+/));
  return words.every((word) => present.has(word));
}

/// `ps -axo pid=,ppid=,args=` as pid, parent and command line.
export function parsePsArgs(text: string): { pid: number; ppid: number; args: string }[] {
  const out: { pid: number; ppid: number; args: string }[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return out;
}

/// The process running each of these services, for the ones with no port.
///
/// A port is the honest handle: something is listening on it or it is not.
/// Without one the only evidence left is the command line and where it runs,
/// so both must agree — every token of what we would launch appears in the
/// process's arguments, and it is working inside that service's checkout.
/// Startup options are part of that command line, which is what tells four
/// copies of one processor apart.
///
/// Ambiguity is refused, in both directions: a process that answers to two
/// services, or a service that two processes answer to, is attributed to
/// neither. Claiming the wrong one would stop the wrong work.
export async function matchingProcesses(
  targets: readonly { key: string; tokens: readonly string[]; checkout: string }[],
  runner: LookupRunner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, ProcessMatch>> {
  const found = new Map<string, ProcessMatch>();
  // Windows `ps` equivalents do not carry the working directory, and without
  // it a command line alone is not evidence enough to claim a process.
  if (targets.length === 0 || platform === 'win32') return found;

  const rows = parsePsArgs((await runner('ps', ['-axo', 'pid=,ppid=,args='])) ?? '');
  if (rows.length === 0) return found;

  // Which services each process could be, and which processes each service
  // could be. Both are needed to refuse the ambiguous cases.
  const keysByPid = new Map<number, string[]>();
  const pidsByKey = new Map<string, number[]>();
  for (const row of rows) {
    for (const target of targets) {
      if (!commandMatches(row.args, target.tokens)) continue;
      keysByPid.set(row.pid, [...(keysByPid.get(row.pid) ?? []), target.key]);
      pidsByKey.set(target.key, [...(pidsByKey.get(target.key) ?? []), row.pid]);
    }
  }

  const candidates = [...pidsByKey.entries()].filter(
    ([key, pids]) => pids.length === 1 && (keysByPid.get(pids[0]) ?? []).length === 1 && key !== undefined,
  );
  if (candidates.length === 0) return found;

  // The parent map comes out of the scan already made: `processFacts` would
  // run a second `ps` for what this one already said.
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const wanted = new Set<number>();
  for (const [, pids] of candidates) {
    let at: number | undefined = pids[0];
    for (let guard = 0; at !== undefined && at > 1 && guard < 64; guard++) {
      wanted.add(at);
      at = parents.get(at);
    }
  }
  const cwds = parseLsofCwds(
    (await runner('lsof', ['-a', '-d', 'cwd', '-p', [...wanted].join(','), '-Fpn'])) ?? '',
  );
  const facts: ProcessFacts = { selfPid: process.pid, parents, cwds };
  for (const [key, pids] of candidates) {
    const pid = pids[0];
    const target = targets.find((t) => t.key === key);
    if (!target) continue;
    const ctx: OwnerContext = { servicePath: target.checkout };
    const cwd = facts.cwds.get(pid);
    if (!cwd || !within(cwd, target.checkout)) continue;
    const row = rows.find((r) => r.pid === pid);
    const kind = classifyOwner(pid, ctx, facts);
    found.set(key, {
      pid,
      command: row?.args ?? '',
      kind,
      ...(kind === 'stale' ? { root: serviceRoot(pid, target.checkout, facts) } : {}),
    });
  }
  return found;
}

/// Ask these processes to stop, then insist. SIGTERM first so a server can
/// close its connections; SIGKILL after a grace period for the one that
/// ignores it. Reports what it managed to signal — "I could not" is a useful
/// answer, since the process may belong to another user.
export async function stopPids(
  pids: readonly number[],
  graceMs = 2_000,
  opts: { tree?: boolean; runner?: LookupRunner } = {},
): Promise<{ stopped: number[]; refused: number[] }> {
  const targets = opts.tree ? await withDescendants(pids, opts.runner ?? run) : [...pids];
  const stopped: number[] = [];
  const refused: number[] = [];
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch {
      // No such process (it exited between the scan and now), or not ours.
      refused.push(pid);
    }
  }
  if (stopped.length === 0) return { stopped, refused };

  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const pid of stopped) {
    try {
      // Signal 0 tests existence without sending anything.
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is what was wanted.
    }
  }
  return { stopped, refused };
}

/// These pids and everything under them, from one `ps`. Deepest first, so the
/// app goes before the launcher that would otherwise notice and report it.
export async function withDescendants(pids: readonly number[], runner: LookupRunner): Promise<number[]> {
  const parents = parsePsParents((await runner('ps', ['-axo', 'pid=,ppid='])) ?? '');
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), child]);

  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number, depth: number) => {
    if (seen.has(pid) || depth > 64) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) visit(child, depth + 1);
    out.push(pid);
  };
  for (const pid of pids) visit(pid, 0);
  return out;
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
  const owners = await portOwners(port, opts.context);
  // The pane never offers this, but a stale banner could still ask.
  const mine = owners.filter((o) => o.kind !== 'self');
  const result = await stopPids(mine.map((o) => o.pid), opts.graceMs ?? 2_000);
  const stopped = owners.filter((o) => result.stopped.includes(o.pid));
  const refused = owners.filter((o) => !result.stopped.includes(o.pid));
  return { stopped, refused };
}

/// One line naming what is on the port, for the banner that offers to stop it.
export function describeOwners(owners: readonly PortOwner[]): string {
  if (owners.length === 0) return 'another program on this machine';
  if (owners.length === 1) return `${owners[0].command} (pid ${owners[0].pid})`;
  return `${owners.length} processes — ${owners.map((o) => o.command).join(', ')}`;
}
