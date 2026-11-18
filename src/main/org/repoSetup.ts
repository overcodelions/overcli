// A connected repo's setup command (`npm ci`), run by the server in each
// fresh checkout before the worker starts, so the checks it is allowed to
// run (`npm run lint-changed`) have their dependencies. And a trial of both,
// from the Repos page, in a throwaway checkout of the default branch.
//
// It runs as the worker's own user, with the worker's environment (the
// toolchains on PATH, no server secrets): install scripts are the repo's
// code, and get exactly what the worker's own shell would. What happened is
// kept per checkout, for the note every step of the run reads.

import { execFile as nodeExecFile } from 'node:child_process';
import { stripSecrets } from './secrets';
import { runEnv } from '../runEnv';
import { workerLaunch } from './workerUser';
import type { ConnectedRepo, SetupOutcome } from './repos';

export const SETUP_TIMEOUT_MS = 15 * 60_000;
/// Setups run side by side in one launch.
export const SETUP_AT_ONCE = 2;
/// How much of a command's output is kept.
const TAIL_CHARS = 1500;
/// Checkouts whose outcome is remembered; the oldest go first.
const KEEP = 300;

export type SetupExec = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/// A throwaway checkout of a repo's default branch, and how to drop it.
export type TrialFork = (repo: ConnectedRepo) => Promise<{ ok: true; worktreePath: string; remove(): Promise<void> } | { ok: false; error: string }>;

export interface RepoSetupDeps {
  repos(): ConnectedRepo[];
  exec?: SetupExec;
  env?: NodeJS.ProcessEnv;
  /// For trials. Absent: trials are refused.
  fork?: TrialFork;
  now?(): number;
  log?(message: string): void;
}

/// One command of a trial.
export interface TrialStep {
  kind: 'setup' | 'check';
  command: string;
  state: 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';
  secs?: number;
  /// The end of what it printed.
  tail?: string;
}

/// A run of a repo's setup and checks, as a worker's checkout would get them.
export interface CheckTrial {
  repo: string;
  startedAt: number;
  finishedAt?: number;
  /// Every command passed. Absent while it runs.
  ok?: boolean;
  /// Why it couldn't run at all.
  error?: string;
  steps: TrialStep[];
}

/// Run `command` in `cwd` as the worker would. `tail`: the end of what it printed.
export function runSetup(command: string, cwd: string, exec: SetupExec = nodeExecFile as unknown as SetupExec, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    try {
      const launch = workerLaunch('/bin/sh', ['-c', command]);
      exec(launch.command, launch.args, { cwd, timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: stripSecrets(runEnv(env, cwd)) }, (err, stdout, stderr) => {
        const said = `${stdout ?? ''}${stderr ?? ''}`.trim();
        resolve({ ok: !err, tail: (said || (err ? err.message : '')).slice(-TAIL_CHARS) });
      });
    } catch (err) {
      resolve({ ok: false, tail: err instanceof Error ? err.message : String(err) });
    }
  });
}

export class RepoSetup {
  private outcomes = new Map<string, SetupOutcome>();
  private trials = new Map<string, CheckTrial>();

  constructor(private readonly deps: RepoSetupDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /// Run each checkout's repo setup, side by side. Checkouts of repos with
  /// none are left alone. Never throws: a failed setup is told to the run.
  async prepare(checkouts: Array<{ projectPath: string; worktreePath: string }>, progress?: (message: string) => void): Promise<void> {
    const repos = this.deps.repos();
    const commands = [...new Set(checkouts.map((c) => repos.find((r) => r.path === c.projectPath)?.setup).filter((s): s is string => !!s))];
    if (!commands.length) return;
    progress?.(`Running ${commands.join(', ')}…`);
    // A few at a time: a workspace run checks out every repo, and thirty
    // installs at once would starve the server.
    const queue = checkouts.filter((c) => repos.find((r) => r.path === c.projectPath)?.setup);
    await Promise.all(
      Array.from({ length: Math.min(SETUP_AT_ONCE, queue.length) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) await this.prepareOne(c, repos);
      }),
    );
  }

  private async prepareOne(c: { projectPath: string; worktreePath: string }, repos: ConnectedRepo[]): Promise<void> {
    const repo = repos.find((r) => r.path === c.projectPath);
    if (!repo?.setup) return;
    const startedAt = this.now();
    const res = await runSetup(repo.setup, c.worktreePath, this.deps.exec, this.deps.env);
    const secs = Math.round((this.now() - startedAt) / 1000);
    this.deps.log?.(`${repo.name}: ${repo.setup} ${res.ok ? 'finished' : 'failed'} in ${secs}s (${c.worktreePath}).`);
    this.remember(c.worktreePath, { repo: repo.name, command: repo.setup, ok: res.ok, ...(res.ok ? {} : { tail: res.tail }) });
  }

  /// What setup did in these checkouts.
  outcomesFor(worktreePaths: string[]): SetupOutcome[] {
    return worktreePaths.map((p) => this.outcomes.get(p)).filter((o): o is SetupOutcome => !!o);
  }

  /// Start a trial of a repo's saved setup and checks, in the background.
  /// One at a time per repo. `done` is for tests.
  startTrial(name: string): { ok: true; trial: CheckTrial; done: Promise<void> } | { ok: false; error: string } {
    const repo = this.deps.repos().find((r) => r.name === name);
    if (!repo) return { ok: false, error: `No connected repo is called ${name}.` };
    if (!this.deps.fork) return { ok: false, error: 'Checks can’t be tried on this server.' };
    if (!repo.setup && !repo.checks?.length) return { ok: false, error: `${name} has no setup or checks to try. Save some first.` };
    const last = this.trials.get(name);
    if (last && last.finishedAt === undefined) return { ok: false, error: 'A trial is already running for this repo.' };
    const trial: CheckTrial = {
      repo: name,
      startedAt: this.now(),
      steps: [
        ...(repo.setup ? [{ kind: 'setup' as const, command: repo.setup, state: 'waiting' as const }] : []),
        ...(repo.checks ?? []).map((command) => ({ kind: 'check' as const, command, state: 'waiting' as const })),
      ],
    };
    this.trials.set(name, trial);
    const done = this.runTrial(repo, trial).catch((err: unknown) => {
      trial.error = err instanceof Error ? err.message : String(err);
    }).finally(() => {
      trial.ok = !trial.error && trial.steps.every((s) => s.state === 'passed');
      trial.finishedAt = this.now();
      this.deps.log?.(`${name}: tried its checks, ${trial.ok ? 'all passed' : 'something failed'}.`);
    });
    return { ok: true, trial, done };
  }

  /// The last trial of a repo, running or done.
  trial(name: string): CheckTrial | undefined {
    return this.trials.get(name);
  }

  private async runTrial(repo: ConnectedRepo, trial: CheckTrial): Promise<void> {
    const forked = await this.deps.fork!(repo);
    if (!forked.ok) {
      trial.error = `Couldn’t make a checkout to try them in: ${forked.error}`;
      return;
    }
    try {
      for (const step of trial.steps) {
        // Checks need what setup installs: past a failed setup, they'd only fail too.
        if (step.kind === 'check' && trial.steps.some((s) => s.kind === 'setup' && s.state === 'failed')) {
          step.state = 'skipped';
          continue;
        }
        step.state = 'running';
        const startedAt = this.now();
        const res = await runSetup(step.command, forked.worktreePath, this.deps.exec, this.deps.env);
        step.secs = Math.round((this.now() - startedAt) / 1000);
        step.state = res.ok ? 'passed' : 'failed';
        step.tail = res.tail;
      }
    } finally {
      await forked.remove().catch(() => undefined);
    }
  }

  private remember(worktreePath: string, outcome: SetupOutcome): void {
    this.outcomes.delete(worktreePath);
    this.outcomes.set(worktreePath, outcome);
    while (this.outcomes.size > KEEP) this.outcomes.delete(this.outcomes.keys().next().value!);
  }
}
