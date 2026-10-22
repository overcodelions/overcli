// `overcli serve` — the daemon.
//
// Everything else in this directory is one-shot: parse a file, run it, exit.
// This is the opposite shape, and the difference is the whole point. The
// scheduler and the standing workers you built in the app have only ever
// existed inside `registerIpc` (src/main/index.ts), so closing the Electron
// window stopped them. Here they run on a box you own, with no window.
//
// There is still no second runtime. `buildDaemonEngines` constructs the same
// engines the app constructs, in the same order; this file only starts them,
// keeps the process alive, and takes them down cleanly on a signal.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { host } from '../main/host';
import { buildDaemonEngines, type DaemonEngines } from './engines';
import { configuredSlackToken, slackEnabled } from '../main/slack/slackSettings';
import { listPeople, type SlackPerson } from '../main/slack/slackApi';
import { fileAuditStore, listTokens, loadOrgPolicy, orgPolicyPath } from '../main/org/orgStores';
import { startHousekeeping } from '../main/org/housekeeping';
import type { OrgCaller } from '../shared/org/policy';
import { createControlPlane, listenControlPlane } from './controlPlane';
import { ensureDefaultProject } from '../main/org/defaultProject';
import { parseControlAddress, type ServeOptions } from './args';
import { EXIT } from './run';
import { nodeHost } from '../main/hostNode';
import { SECRETS_ENV, SecretsService, createSecretStore, parseSecretsSpec, type SecretStore } from '../main/org/secrets';
import { autonomousWithoutGrant } from '../main/org/orgService';
import { draftProcessFromImage } from '../main/org/processDraft';
import { drafterDepsFor } from '../main/org/hireDraft';

/// Node's timer ceiling is 2^31-1 ms; stay comfortably under it.
const KEEP_ALIVE_MS = 1 << 30;

export const LOCK_FILE = 'serve.lock';

export interface ServeHandle {
  engines: DaemonEngines;
  /// Resolves once a signal has been handled and both engines are disposed.
  /// `main` returns this, which is what keeps the process alive: nothing else
  /// is holding the event loop open on purpose.
  done: Promise<number>;
  /// The signal handler. Exposed so a test can fire it directly instead of
  /// signalling the test runner's own process, which would kill vitest.
  shutdown: (signal: string) => void;
}

export interface ServeDeps {
  /// Where the startup and shutdown lines go. stdout in production.
  out: (line: string) => void;
  /// Escalation for a second signal. Defaults to a real `process.exit`; a test
  /// passes its own so it can assert the escalation without dying.
  forceExit?: (code: number) => void;
}

/// Refuse to run two daemons against one state directory.
///
/// Nothing else in overcli guards this, and the failure is silent and bad:
/// both processes `loadAllSchedules()` from the same directory and both arm
/// timers, so every schedule fires TWICE — two worktrees, two branches, two
/// sets of API spend — while both append to the same worker journal and
/// treasury. A stale lock (the holder crashed) is not an error and is taken
/// over; `process.kill(pid, 0)` is the liveness probe, and it throws ESRCH for
/// a pid that is gone.
export function acquireLock(dataDir: string): { ok: true; release: () => void } | { ok: false; heldBy: number } {
  // Self-contained on purpose: the takeover race test runs this function's
  // source in child processes, so it may reach nothing at module scope but
  // `fs`, `path` and `LOCK_FILE`.
  const file = path.join(dataDir, LOCK_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = path.join(dataDir, `.${LOCK_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(temp, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  const claim = (): boolean => {
    try {
      fs.linkSync(temp, file);
      return true;
    } catch {
      return false;
    }
  };
  /// The pid in the lock; `null` when there is no lock file at all. A file
  /// that is there but holds no pid (0 or NaN) is corrupt, never a claim in
  /// progress: a claim is a hard link to a fully written temp file, so it
  /// appears complete or not at all.
  const holder = (): number | null => {
    try {
      return Number(fs.readFileSync(file, 'utf-8').trim());
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : NaN;
    }
  };
  const pidOf = (n: number | null): number => (n !== null && Number.isInteger(n) && n > 0 ? n : 0);
  const acquired = { ok: true as const, release: () => {
    try {
      // Only drop it if it is still ours — never delete a lock another
      // process took over after we went stale.
      if (Number(fs.readFileSync(file, 'utf-8').trim()) === process.pid) fs.unlinkSync(file);
    } catch {
      // Nothing to release.
    }
  } };
  try {
    // A few rounds, because the lock can vanish between our failed claim and
    // our read of it — its holder released it. That is not a stale lock to
    // take over, it is a free one to CLAIM, and another contender may already
    // have: unlinking at that point is how two daemons end up running.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (claim()) return acquired;
      const held = holder();
      if (held === null) continue;
      if (pidOf(held) > 0 && held !== process.pid) {
        try {
          process.kill(held, 0);
          return { ok: false, heldBy: held };
        } catch {
          // ESRCH — stale.
        }
      }
      // Serialize stale takeover itself: otherwise two contenders can both
      // observe the old holder and one can unlink the other's fresh claim.
      const takeover = `${file}.takeover`;
      let ownsTakeover = false;
      try {
        fs.linkSync(temp, takeover);
        ownsTakeover = true;
      } catch {
        const takeoverHolder = (() => {
          try { return Number(fs.readFileSync(takeover, 'utf8').trim()); } catch { return 0; }
        })();
        try {
          if (takeoverHolder > 0) process.kill(takeoverHolder, 0);
        } catch {
          try { fs.unlinkSync(takeover); } catch { /* raced */ }
        }
        try {
          fs.linkSync(temp, takeover);
          ownsTakeover = true;
        } catch { /* live contender owns it */ }
      }
      if (!ownsTakeover) return { ok: false, heldBy: pidOf(holder()) || pidOf(held) };
      try {
        // Only remove the exact stale (or corrupt) lock we inspected. If the
        // file changed or vanished since, a new claimant owns it and wins.
        if (Object.is(holder(), held)) fs.unlinkSync(file);
      } catch { /* raced */ }
      finally {
        try { fs.unlinkSync(takeover); } catch { /* gone */ }
      }
      // Losing this second race means another daemon claimed it in the gap.
      if (claim()) return acquired;
      return { ok: false, heldBy: pidOf(holder()) || pidOf(held) };
    }
    // The lock kept appearing and vanishing under us — someone else is
    // cycling on it. Refuse rather than guess.
    return { ok: false, heldBy: pidOf(holder()) };
  } finally {
    try { fs.unlinkSync(temp); } catch { /* linked or already gone */ }
  }
}

/// Build, start, and hold. Returns without waiting, so the caller decides how
/// signals reach `shutdown`.
export function startDaemon(
  opts: ServeOptions,
  deps: ServeDeps,
  secrets?: SecretsService,
): { ok: true; handle: ServeHandle } | { ok: false; exitCode: number; error: string } {
  const engines = buildDaemonEngines({
    stateDir: opts.stateDir,
    policy: opts.permissions,
    allowTools: opts.allowTools,
    ...(secrets ? { secrets } : {}),
  });
  // A new Slack token from Setup → Secrets: reconnect with it.
  secrets?.onChange((names) => {
    if (names.some((n) => n.startsWith('OVERCLI_SLACK_')) && slackEnabled()) void engines.slack.start();
  });
  secrets?.start();

  // Read AFTER the engines exist: `buildDaemonEngines` installs the host, and
  // `dataDir()` is what resolves --state-dir / $OVERCLI_HOME / ~/.overcli.
  const dataDir = host().dataDir();

  const lock = acquireLock(dataDir);
  if (!lock.ok) {
    engines.dispose();
    return {
      ok: false,
      exitCode: EXIT.RUN_FAILED,
      error:
        `Another overcli serve (pid ${lock.heldBy}) is already using ${dataDir}.\n` +
        'Two daemons on one state directory fire every schedule twice. Stop that one first.',
    };
  }

  // Schedules fire in the process's local time. A container runs in UTC, so
  // "weekdays at 09:00" would mean 09:00 UTC; the org's time zone, when
  // org.json names one and TZ is not set, makes it 09:00 where the org is.
  const orgZone = loadOrgPolicy().policy.timezone;
  // Set by the operator: theirs to keep. Otherwise the org's, and it follows
  // org.json while running (housekeeping below).
  const zoneFromOrg = !process.env.TZ;
  if (orgZone && zoneFromOrg) process.env.TZ = orgZone;
  engines.scheduler.start();
  engines.workerEngine.start();
  for (const w of autonomousWithoutGrant(engines.workerEngine.roster())) engines.workerEngine.save(w);
  const carried = carryOnInterrupted(engines, opts);
  if (carried) deps.out(`runs: carried on ${carried} that a restart cut short`);
  const asked = engines.org.resumeAsks();
  if (asked) deps.out(`asks: asked ${asked} again that a restart cut short`);
  engines.teams.start();
  engines.triggers.start();
  void ensureDefaultProject().then((dir) => {
    if (dir) deps.out(`projects: none registered, so workers will work in ${dir}. Add repos with overcli projects add.`);
  });
  // The org control plane: MCP at /mcp, the console at /. $OVERCLI_CONTROL
  // is the container-friendly spelling of --control.
  let control: http.Server | null = null;
  const controlAt = opts.control ?? (process.env.OVERCLI_CONTROL ? parseControlAddress(process.env.OVERCLI_CONTROL) : undefined);
  if (controlAt && 'error' in controlAt) {
    deps.out(`control: not started — $OVERCLI_CONTROL: ${controlAt.error}`);
  } else if (controlAt) {
    const server = createControlPlane({ org: engines.org, access: engines.access, sso: engines.sso, connections: engines.connections, triggers: engines.triggers, processes: engines.processes, slackConversations: engines.slackConversations,
      draftProcess: (input) => draftProcessFromImage(drafterDepsFor(engines.runner), input), slackPeople: slackDirectory(), log: deps.out });
    control = server;
    listenControlPlane(server, controlAt).then(
      () => {
        const shown = controlAt.host.includes(':') ? `[${controlAt.host}]` : controlAt.host;
        deps.out(`control: http://${shown}:${controlAt.port}/ (console) and /mcp`);
        if (listTokens().length === 0) {
          // First run: nobody can sign in yet. Rather than send the operator
          // off to mint a token, hand them a one-time link that signs the
          // first admin in — the same invite anyone else gets.
          const policy = loadOrgPolicy().policy;
          const first = policy.admins[0];
          const base = policy.publicUrl ?? `http://${shown}:${controlAt.port}`;
          void engines.access
            .invite({ name: 'overcli', admin: true }, { name: 'Admin', ...(first ? { slackUserId: first } : {}), role: 'admin', setup: true }, base)
            .then((res) => {
              if (res.ok) deps.out(`control: nobody has signed in yet. Open this once to sign in as the first admin: ${res.link}`);
            });
        }
        const policy = loadOrgPolicy();
        if (!policy.fromFile) deps.out(`control: no ${orgPolicyPath()} — run overcli org init. Until then nobody but admin tokens may hire.`);
      },
      (err: unknown) => deps.out(`control: could not listen on ${controlAt.host}:${controlAt.port} — ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  if (slackEnabled()) {
    void engines.slack.start().then((res) => {
      if (res.ok) deps.out('slack: connected — workers DM their managers');
      else deps.out(`slack: not connected — ${res.error}`);
    });
  }

  const schedules = engines.scheduler.list();
  const enabled = schedules.filter((s) => s.enabled).length;
  const workers = engines.workerEngine.workerIds().length;
  deps.out(
    `overcli serve — ${schedules.length} schedule(s) (${enabled} enabled), ` +
      `${workers} worker(s) from ${dataDir}`,
  );
  deps.out(`permissions: ${opts.permissions}; pid ${process.pid}; Ctrl-C or SIGTERM to stop`);

  // Without this the process exits immediately on an empty state directory.
  // `SchedulerEngine.arm()` returns early with `// nothing enabled — no timer
  // at all` (scheduler.ts:289) when no schedule is due, and the worker engine
  // does the same, so with nothing to run neither engine holds the event loop
  // open and node would fall straight out of `main`. A daemon with no work yet
  // still has to be up — the user may add a schedule from the app.
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
  // A console ask's handed-off work, back to its worker to finish up once it
  // ends. Slack's front door does its own, to answer in the thread.
  const handBack = setInterval(() => engines.org.handBackDue(), 30_000);

  const everyone: OrgCaller = { name: 'overcli', admin: true };
  const housekeeping = startHousekeeping({
    policy: () => loadOrgPolicy().policy,
    workers: () => engines.org.listWorkers(everyone),
    managerSlackId: (id) => engines.org.managerSlackId(id),
    pool: { get: () => engines.workerEngine.treasury().treasury.monthlyUSD, set: (usd) => engines.workerEngine.setTreasury(usd) },
    rearm: () => {
      engines.scheduler.onHostResume();
      engines.workerEngine.onHostResume();
    },
    notify: (to, title, body) => engines.commands.tellPeople(to, title, body),
    audit: fileAuditStore,
    runs: { list: () => engines.flowRuntime.listRuns(), delete: (runId) => engines.flowRuntime.deleteRun({ runId }) },
    stateFile: path.join(dataDir, 'org', 'housekeeping.json'),
    log: deps.out,
    zoneFromOrg,
  });

  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // The first shutdown is still in flight and the user asked again. They
      // are entitled to an exit now, even if that strands a backend process.
      deps.out(`${signal} again — forcing exit.`);
      (deps.forceExit ?? ((code: number) => process.exit(code)))(EXIT.OK);
      return;
    }
    shuttingDown = true;
    deps.out(`${signal} — stopping schedules and workers.`);
    clearInterval(keepAlive);
    clearInterval(handBack);
    housekeeping.stop();
    secrets?.stop();
    engines.triggers.stop();
    control?.close();
    try {
      engines.dispose();
    } finally {
      lock.release();
    }
    resolveDone(EXIT.OK);
  };

  return { ok: true, handle: { engines, done, shutdown } };
}

/// The command as `main` calls it: start, wire real signals, wait forever.
export async function serveCommand(opts: ServeOptions, deps: ServeDeps): Promise<number> {
  // Secrets first: the engines, Slack and git read them from the environment.
  const secrets = await loadSecrets(opts, deps);
  if (!secrets.ok) {
    process.stderr.write(`${secrets.error}\n`);
    return EXIT.BAD_INPUT;
  }
  const started = startDaemon(opts, deps, secrets.service);
  if (!started.ok) {
    process.stderr.write(`${started.error}\n`);
    return started.exitCode;
  }
  // systemd sends SIGTERM on `systemctl stop`; Ctrl-C sends SIGINT. Both mean
  // the same thing here. Exit 0 rather than the 128+n convention because a
  // clean, intentional stop is a success, and systemd would otherwise need
  // SuccessExitStatus configured to agree.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => started.handle.shutdown(signal));
  }
  return started.handle.done;
}

/// Worker runs a restart cut short (a deploy, an upgrade, a crash) pick up
/// where they stopped, at the start of the step they were in. A step that
/// acts outside the server was already turned back into an approval when
/// the run was restored (runtime.ts), so nothing is pushed or sent twice
/// without a person saying so. A day old or more, they wait for someone.
/// They run under the allow-list the server has now, not the one they
/// started with.
function carryOnInterrupted(engines: DaemonEngines, opts: ServeOptions): number {
  let count = 0;
  for (const run of engines.flowRuntime.listRuns()) {
    if (!run.workerId || run.state.kind !== 'paused' || run.state.reason !== 'interrupted') continue;
    if (Date.now() - run.createdAt > 24 * 3_600_000) continue;
    if (run.unattended && opts.permissions === 'allow-list') run.unattendedAllowedTools = opts.allowTools;
    if (engines.flowRuntime.resumeRun({ runId: run.id }).ok) count++;
  }
  return count;
}

/// The secrets store $OVERCLI_SECRETS names (an encrypted file by default),
/// read once before anything starts.
async function loadSecrets(opts: ServeOptions, deps: ServeDeps): Promise<{ ok: true; service: SecretsService } | { ok: false; error: string }> {
  const spec = parseSecretsSpec(process.env[SECRETS_ENV]);
  if (!spec.ok) return spec;
  let store: SecretStore;
  try {
    store = await createSecretStore(spec.spec, nodeHost({ dataDir: opts.stateDir }).dataDir());
  } catch (err) {
    return { ok: false, error: `secrets: could not open the store: ${err instanceof Error ? err.message : String(err)}` };
  }
  const service = new SecretsService({ store, log: deps.out });
  const loaded = await service.load();
  deps.out(loaded.ok ? `secrets: ${store.where}${store.readOnly ? ' (read-only)' : ''}` : `secrets: ${loaded.error} — starting with the environment only`);
  if (store.warning) deps.out(`secrets: ${store.warning}`);
  return { ok: true, service };
}

/// People in the org's Slack, for the invite picker: listed once and kept
/// ten minutes, since a directory read pages through the whole workspace.
function slackDirectory(): () => Promise<SlackPerson[]> {
  let cache: { at: number; people: SlackPerson[] } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache.people;
    const bot = configuredSlackToken('bot');
    if (!bot) return [];
    const res = await listPeople(bot);
    if (!res.ok) return cache?.people ?? [];
    cache = { at: Date.now(), people: res.data };
    return res.data;
  };
}
