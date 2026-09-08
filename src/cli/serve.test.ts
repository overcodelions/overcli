// `overcli serve`. Three things are worth proving and they need different
// machinery, so this file is in three parts.
//
// The daemon-boot part deliberately builds the REAL engines against a real
// temp state directory rather than mocking `./engines`. A mock would prove
// that `startDaemon` calls two methods, which is not the claim — the claim is
// that the scheduler and the worker engine can be started headless at all,
// which is precisely what nobody had ever done before this command existed.
// There is no `vi.mock('electron')` here for the same reason `noElectron.test.ts`
// exists: nothing on this graph may reach electron, so there is nothing to mock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from './args';
import { EXIT } from './run';
import { acquireLock, LOCK_FILE, startDaemon } from './serve';

const tmpdirs: string[] = [];

function tmpStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-serve-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpdirs.length) {
    const dir = tmpdirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('parseArgs — serve', () => {
  it('is accepted as a command, with run’s defaults', () => {
    const parsed = parseArgs(['serve']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.command).toBe('serve');
    expect(parsed.args.serve).toEqual({ permissions: 'deny', allowTools: [] });
    expect(parsed.args.warnings).toEqual([]);
    // `serve` must not fabricate a RunOptions — `run.ts` keys off its presence.
    expect(parsed.args.run).toBeUndefined();
  });

  it('takes no YAML file, unlike run', () => {
    // The whole point: the work comes from the state dir, not from a file.
    expect(parseArgs(['run'])).toEqual({ ok: false, error: 'overcli run needs a YAML file.' });
    const parsed = parseArgs(['serve', 'flow.yaml']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('overcli serve takes no file arguments (got "flow.yaml").');
  });

  it('accepts --state-dir, --permissions and --allow-tool, in both flag spellings', () => {
    const parsed = parseArgs([
      'serve',
      '--state-dir',
      '/tmp/state',
      '--permissions=allow-list',
      '--allow-tool',
      'Read,Bash',
      '--allow-tool=Grep',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.serve).toEqual({
      stateDir: '/tmp/state',
      permissions: 'allow-list',
      allowTools: ['Read', 'Bash', 'Grep'],
    });
  });

  it('validates --permissions exactly as run does', () => {
    const bad = parseArgs(['serve', '--permissions', 'sure-why-not']);
    const badRun = parseArgs(['run', 'f.yaml', '--permissions', 'sure-why-not']);
    expect(bad.ok).toBe(false);
    if (bad.ok || badRun.ok) return;
    expect(bad.error).toBe(
      '--permissions must be one of deny, allow-list, auto-approve (got "sure-why-not").',
    );
    // Same message from both commands — the shared helper is the point.
    expect(bad.error).toBe(badRun.error);
  });

  it('warns about --allow-tool without allow-list, exactly as run does', () => {
    const serve = parseArgs(['serve', '--allow-tool', 'Bash']);
    const run = parseArgs(['run', 'f.yaml', '--allow-tool', 'Bash']);
    expect(serve.ok && run.ok).toBe(true);
    if (!serve.ok || !run.ok) return;
    expect(serve.args.warnings).toEqual([
      '--allow-tool only applies under --permissions allow-list; ignoring 1 of them.',
    ]);
    expect(serve.args.warnings).toEqual(run.args.warnings);
  });

  it('warns about allow-list with no tools, exactly as run does', () => {
    const serve = parseArgs(['serve', '--permissions', 'allow-list']);
    expect(serve.ok).toBe(true);
    if (!serve.ok) return;
    expect(serve.args.warnings).toEqual([
      '--permissions allow-list with no --allow-tool denies everything, same as --permissions deny.',
    ]);
  });

  it('refuses run-only flags by name rather than ignoring them', () => {
    const parsed = parseArgs(['serve', '--cwd', '/repo']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('--cwd is a "run" option');
  });

  it('still refuses an unknown flag, and an unknown command names serve', () => {
    expect(parseArgs(['serve', '--nope'])).toEqual({ ok: false, error: 'Unknown option "--nope".' });
    const unknown = parseArgs(['wibble']);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toContain('overcli serve');
  });

  it('needs a value for a value flag', () => {
    expect(parseArgs(['serve', '--state-dir'])).toEqual({
      ok: false,
      error: '--state-dir needs a value.',
    });
  });
});

describe('acquireLock', () => {
  it('writes our pid and releases it', () => {
    const dir = tmpStateDir();
    const lock = acquireLock(dir);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    expect(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8').trim()).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('refuses when a live process holds it', () => {
    const dir = tmpStateDir();
    // A pid that is definitely alive and definitely not us: our own parent.
    // (ppid 0/1 would be init, which `kill(pid, 0)` may report as alive but
    // which we can also legitimately fail to signal — use it only if real.)
    const alive = process.ppid > 1 ? process.ppid : process.pid;
    fs.writeFileSync(path.join(dir, LOCK_FILE), `${alive}\n`);
    if (alive === process.pid) {
      // Same-pid means "ours", which is takeover, not conflict — skip.
      expect(acquireLock(dir).ok).toBe(true);
      return;
    }
    const lock = acquireLock(dir);
    expect(lock.ok).toBe(false);
    if (lock.ok) return;
    expect(lock.heldBy).toBe(alive);
  });

  it('takes over a stale lock whose holder is gone', () => {
    const dir = tmpStateDir();
    // Very high pid that cannot be running.
    fs.writeFileSync(path.join(dir, LOCK_FILE), '4294967295\n');
    const lock = acquireLock(dir);
    expect(lock.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8').trim()).toBe(String(process.pid));
  });

  it('survives a corrupt lock file', () => {
    const dir = tmpStateDir();
    fs.writeFileSync(path.join(dir, LOCK_FILE), 'not-a-pid\n');
    expect(acquireLock(dir).ok).toBe(true);
  });
});

describe('the daemon', () => {
  it('boots both engines with no flow file, and shuts down on SIGTERM', async () => {
    const dir = tmpStateDir();
    const lines: string[] = [];
    const started = startDaemon(
      { permissions: 'deny', allowTools: [], stateDir: dir },
      { out: (l) => lines.push(l) },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { engines, shutdown, done } = started.handle;

    // Both engines really started: `start()` loads persisted state, so `list()`
    // answering at all (rather than throwing) is the evidence the load ran.
    expect(engines.scheduler.list()).toEqual([]);
    expect(engines.workerEngine.workerIds()).toEqual([]);
    expect(lines[0]).toContain('0 schedule(s) (0 enabled), 0 worker(s)');
    expect(lines[0]).toContain(dir);
    expect(lines[1]).toContain('permissions: deny');

    // The lock is held for as long as the daemon is up.
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true);

    const schedulerDispose = vi.spyOn(engines.scheduler, 'dispose');
    const workerDispose = vi.spyOn(engines.workerEngine, 'dispose');
    const killAll = vi.spyOn(engines.runner, 'killAll');

    shutdown('SIGTERM');

    await expect(done).resolves.toBe(EXIT.OK);
    expect(schedulerDispose).toHaveBeenCalledTimes(1);
    expect(workerDispose).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe('SIGTERM — stopping schedules and workers.');
    // ...and the lock is gone, so the next daemon can start.
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('refuses to start when another live daemon holds the state dir', () => {
    const dir = tmpStateDir();
    // A FOREIGN live pid, which is what a second daemon actually looks like.
    // Two `startDaemon` calls in one test process would NOT reproduce it: the
    // lock records a pid, and a lock already carrying our own pid is by design
    // ours to take over rather than a conflict — otherwise a process could
    // deadlock against its own stale lock.
    const alive = process.ppid;
    if (alive <= 1) return; // no usable foreign pid on this host
    fs.writeFileSync(path.join(dir, LOCK_FILE), `${alive}\n`);

    const blocked = startDaemon(
      { permissions: 'deny', allowTools: [], stateDir: dir },
      { out: () => {} },
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.exitCode).toBe(EXIT.RUN_FAILED);
    expect(blocked.error).toContain(`pid ${alive}`);
    expect(blocked.error).toContain('fire every schedule twice');
    // The holder's lock is left exactly as it was.
    expect(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8').trim()).toBe(String(alive));
  });

  it('force-exits on a second signal instead of hanging', async () => {
    const dir = tmpStateDir();
    const forced: number[] = [];
    const lines: string[] = [];
    const started = startDaemon(
      { permissions: 'deny', allowTools: [], stateDir: dir },
      { out: (l) => lines.push(l), forceExit: (c) => forced.push(c) },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    started.handle.shutdown('SIGTERM');
    await expect(started.handle.done).resolves.toBe(EXIT.OK);
    expect(forced).toEqual([]);

    const disposeCalls = vi.spyOn(started.handle.engines.scheduler, 'dispose');
    started.handle.shutdown('SIGINT');
    expect(forced).toEqual([EXIT.OK]);
    // The escalation path must not run disposal a second time.
    expect(disposeCalls).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe('SIGINT again — forcing exit.');
  });
});
