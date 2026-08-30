// `overcli run <file.yaml>` — one flow, or one worker shift, then exit.
//
// The file decides which. A worker bundle declares `kind: worker` and carries
// its flows inline (workerYaml.ts); anything else is read as a flow. Nothing
// about the invocation says which it is, so the same command deploys either
// and a pipeline author does not have to know the difference.
//
// What this owns that the app does not have to:
//
//   - Materialising the file. The app's library is a directory the user has
//     been filling for months; here the flow arrives as an argument and has to
//     be written into the (usually empty) headless library before `startRun`
//     can resolve it by id.
//   - Waiting. In the app a run finishes into a pane somebody is looking at.
//     Here the process has to stay alive until the run is terminal and then
//     turn that into an exit code, because that exit code IS the result as far
//     as the pipeline is concerned.
//   - Deciding when "paused" means failure. A run that stops for a human is
//     neither success nor failure; it is exit code 2, distinct from both, so a
//     pipeline can retry it or route it to review instead of treating a
//     needs-input as a broken build.

import fs from 'node:fs';
import path from 'node:path';

import { saveFlow } from '../main/flows/storage';
import { preflightRun } from '../main/flows/preflight';
import { saveWorker } from '../main/flows/workersStore';
import { Store } from '../main/store';
import { parseFlowYaml } from '../shared/flows/yaml';
import { parseWorkerYaml } from '../shared/flows/workerYaml';
import { validateFlow } from '../shared/flows/validation';
import { resolveStepModel, type Flow } from '../shared/flows/schema';
import type { FlowRun } from '../shared/flows/schema';
import type { Worker } from '../shared/flows/worker';
import type { MainToRendererEvent } from '../shared/types';
import { buildEngines, ensureProject, type HeadlessEngines } from './engines';
import { defaultCwd, type RunOptions } from './args';
import type { PermissionDecision } from './permissions';

/// Exit codes are the CLI's whole API to a pipeline, so they are enumerated
/// rather than inlined. `NEEDS_HUMAN` is the one worth knowing about: it is
/// not a failure, and a job that treats it as one will retry work that is
/// sitting waiting for an approval.
export const EXIT = {
  OK: 0,
  RUN_FAILED: 1,
  NEEDS_HUMAN: 2,
  PREFLIGHT: 3,
  BAD_INPUT: 4,
  TIMEOUT: 5,
} as const;

export interface RunSummary {
  ok: boolean;
  kind: 'flow' | 'worker';
  status: string;
  exitCode: number;
  flowId?: string;
  runId?: string;
  workerId?: string;
  projectPath: string;
  steps: Array<{ id: string; status: string }>;
  artifacts: Array<{ name: string; path?: string }>;
  permissionDecisions: Array<{ tool: string; approved: boolean; reason: string }>;
  warnings: string[];
  error?: string;
}

export function preflightFailure(
  summaryBase: Omit<RunSummary, 'flowId' | 'status' | 'exitCode' | 'error'>,
  flowId: string,
  status: 'preflight-failed' | 'start-failed',
  error: string,
): RunSummary {
  return { ...summaryBase, flowId, status, exitCode: EXIT.PREFLIGHT, error };
}

export interface Reporter {
  /// Human-readable progress, or a JSON line under `--json`. Always stderr,
  /// so `--json`'s stdout stays exactly one parseable object.
  progress: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string) => void;
}

export function makeReporter(json: boolean): Reporter {
  return {
    progress(message, data) {
      if (json) process.stderr.write(JSON.stringify({ t: 'progress', message, ...data }) + '\n');
      else process.stderr.write(`  ${message}\n`);
    },
    warn(message) {
      if (json) process.stderr.write(JSON.stringify({ t: 'warning', message }) + '\n');
      else process.stderr.write(`! ${message}\n`);
    },
  };
}

/// A stable id for a worker that arrived as a file. Worker YAML carries no id
/// — deliberately, it is bookkeeping about one install's copy — but a CI job
/// with `--state-dir` needs the SECOND run to find the first one's journal,
/// cabinet and shift count. Deriving it from the name is what makes the state
/// directory work as a persistence layer: same file, same worker, every time.
export function workerIdFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `cli-${slug || 'worker'}`;
}

/// Swap backends before anything looks at them. `--model-override ollama=claude:sonnet`
/// means "wherever this flow says ollama, run claude/sonnet instead", and it
/// has to happen before preflight or preflight fails the run for a model the
/// runner was never going to use.
export function applyModelOverrides(
  flow: Flow,
  overrides: Array<{ from: string; to: string }>,
): { flow: Flow; changed: string[] } {
  if (overrides.length === 0) return { flow, changed: [] };
  const changed: string[] = [];
  const next: Flow = { ...flow, participants: flow.participants.map((p) => ({ ...p })) };
  for (const { from, to } of overrides) {
    const colon = to.indexOf(':');
    const toBackend = (colon === -1 ? to : to.slice(0, colon)) as Flow['participants'][number]['backend'];
    const toModel = colon === -1 ? '' : to.slice(colon + 1);
    for (const p of next.participants) {
      if (p.backend !== from) continue;
      changed.push(`${p.id}: ${p.backend}${p.model ? `/${p.model}` : ''} -> ${toBackend}/${toModel}`);
      p.backend = toBackend;
      if (toModel) p.model = toModel;
    }
  }
  return { flow: next, changed };
}

function readSource(file: string): { ok: true; body: string; id: string } | { ok: false; error: string } {
  try {
    const body = fs.readFileSync(file, 'utf-8');
    const id = path.basename(file).replace(/\.(ya?ml)$/i, '').replace(/\.worker$/i, '');
    return { ok: true, body, id };
  } catch (err) {
    return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function isWorkerFile(body: string): boolean {
  // Cheap and deliberately not a YAML parse: the parsers below produce far
  // better errors than a pre-parse would, and this only has to route.
  return /^\s*kind:\s*['"]?worker['"]?\s*$/m.test(body);
}

const TERMINAL_ITEM = new Set(['done', 'failed', 'cancelled']);

export async function runFile(
  opts: RunOptions,
  reporter: Reporter,
): Promise<{ summary: RunSummary; engines: HeadlessEngines | null }> {
  const projectPath = path.resolve(opts.cwd ?? defaultCwd(process.env, process.cwd()));
  const warnings: string[] = [];
  const decisions: PermissionDecision[] = [];

  const base: RunSummary = {
    ok: false,
    kind: 'flow',
    status: 'unstarted',
    exitCode: EXIT.BAD_INPUT,
    projectPath,
    steps: [],
    artifacts: [],
    permissionDecisions: [],
    warnings,
  };

  const source = readSource(opts.file);
  if (!source.ok) return { summary: { ...base, error: source.error }, engines: null };

  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return {
      summary: { ...base, error: `--cwd ${projectPath} is not a directory.` },
      engines: null,
    };
  }

  const kind: 'flow' | 'worker' = isWorkerFile(source.body) ? 'worker' : 'flow';

  // Decided before the engines exist, because the permission tap is built with
  // them. A second parse of the same bytes is the cost; `runWorker` re-parses
  // so it stays readable on its own, and the file is a few kilobytes.
  //
  // Why it is needed at all: the runtime's worker boundary auto-denies
  // `permissionRequest` for a worker with no external-action grant, but not
  // `codexApproval` — see `denyCodexApprovals` in permissions.ts.
  const peek = kind === 'worker' ? parseWorkerYaml(source.body) : null;
  const denyCodexApprovals = peek?.ok === true && !peek.bundle.worker.caps.allowExternalActions;

  const engines = buildEngines({
    stateDir: opts.stateDir,
    policy: opts.permissions,
    allowTools: opts.allowTools,
    denyCodexApprovals,
    onPermission: (d) => {
      decisions.push(d);
      reporter.progress(d.reason, { tool: d.toolName, approved: d.approved });
    },
    onEvent: (event) => reportEvent(event, reporter),
    onNotify: ({ title, body }) => reporter.progress(`${title}: ${body}`),
  });

  ensureProject(projectPath);
  if (opts.branchPrefix) {
    const settings = Store.load().settings;
    Store.saveSettings({ ...settings, agentBranchPrefix: opts.branchPrefix });
  }

  const summaryBase = { ...base, kind, projectPath };

  if (kind === 'worker') {
    return {
      summary: await runWorker({ opts, source, projectPath, engines, reporter, warnings, decisions, summaryBase }),
      engines,
    };
  }
  return {
    summary: await runFlow({ opts, source, projectPath, engines, reporter, warnings, decisions, summaryBase }),
    engines,
  };
}

interface RunContext {
  opts: RunOptions;
  source: { body: string; id: string };
  projectPath: string;
  engines: HeadlessEngines;
  reporter: Reporter;
  warnings: string[];
  decisions: PermissionDecision[];
  summaryBase: RunSummary;
}

async function runFlow(ctx: RunContext): Promise<RunSummary> {
  const { opts, source, projectPath, engines, reporter, warnings, decisions, summaryBase } = ctx;

  const parsed = parseFlowYaml({
    yaml: source.body,
    id: source.id,
    source: 'user',
    filePath: path.resolve(opts.file),
  });
  if (!parsed) {
    return { ...summaryBase, error: `${opts.file} is not a readable flow (or worker) YAML file.` };
  }

  const { flow, changed } = applyModelOverrides(parsed, opts.modelOverrides);
  for (const c of changed) reporter.progress(`model override — ${c}`);

  const valid = validateFlow(flow);
  if (!valid.ok) {
    return {
      ...summaryBase,
      flowId: flow.id,
      error: `Flow is invalid: ${valid.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    };
  }

  // The runtime resolves flows by id out of the library, so the file has to be
  // IN the library before startRun — see loadAllFlows in runtime.startRun.
  const saved = saveFlow({ flow, target: 'user' });
  if (!saved.ok) return preflightFailure(summaryBase, flow.id, 'preflight-failed', `Could not stage the flow: ${saved.error}`);
  for (const risk of saved.risks) {
    if (risk.severity === 'high') warnings.push(`risk: ${risk.message}`);
  }

  const settings = Store.load().settings;
  const pre = await preflightRun({ flow, projectPath, settings });
  if (!pre.ok) return preflightFailure(summaryBase, flow.id, 'preflight-failed', pre.problems.map((p) => `${p.path}: ${p.message}`).join('; '));

  reporter.progress(`starting ${flow.name} (${flow.steps.length} steps) in ${projectPath}`);
  const started = await engines.flowRuntime.startRun({
    flowId: flow.id,
    projectPath,
    userPrompt: opts.input ?? '',
    runIn: opts.runIn ?? 'cwd',
    // Without this the run resolves to `bypassPermissions` and never emits a
    // permission request, so --permissions would restrain nothing at all.
    unattended: opts.permissions !== 'auto-approve',
    // deny -> [] -> nothing pre-authorised, so every tool call reaches the tap.
    unattendedAllowedTools: opts.permissions === 'allow-list' ? opts.allowTools : [],
  });
  if (!started.ok) {
    return preflightFailure(summaryBase, flow.id, 'start-failed', started.error);
  }

  const run = await waitForRun(engines, started.runId, opts.timeoutSeconds);
  return summariseRun({ run, flow, summaryBase, decisions, warnings, runId: started.runId });
}

async function runWorker(ctx: RunContext): Promise<RunSummary> {
  const { opts, source, projectPath, engines, reporter, warnings, decisions, summaryBase } = ctx;

  const parsed = parseWorkerYaml(source.body);
  if (!parsed.ok) return { ...summaryBase, error: parsed.error };

  // A worker bundle carries its flows inline; they have to land in the library
  // before the engine can launch any of them. `missingFlowIds` is fatal here
  // (it is only a warning in the app, where the user can go add the flow) —
  // there is nobody to fix it and the shift would propose work it cannot do.
  if (parsed.missingFlowIds.length > 0) {
    return {
      ...summaryBase,
      error:
        `This worker names flows the file does not carry: ${parsed.missingFlowIds.join(', ')}. ` +
        're-export the bundle from an install that has them.',
    };
  }
  for (const flow of parsed.bundle.flows) {
    const staged = saveFlow({ flow, target: 'user' });
    if (!staged.ok) return { ...summaryBase, error: `Could not stage flow ${flow.id}: ${staged.error}` };
  }

  const portable = parsed.bundle.worker;
  const id = workerIdFromName(portable.name);
  if (portable.cadence) {
    warnings.push(
      `cadence is ignored by \`overcli run\` — this is one shift, now. Put the schedule in the CI job instead.`,
    );
  }
  if (opts.trust === 'probation') {
    warnings.push(
      'worker is on probation (the default), so every proposal parks for review and this job will exit 2. ' +
        'Pass --trust trusted or --trust autonomous to let the shift launch its own work.',
    );
  }
  if (!opts.stateDir) {
    warnings.push(
      'no --state-dir: this worker starts with an empty journal, so every run is shift 1 and the budget cannot accrue.',
    );
  }

  const existing = engines.workerEngine.list().find((row) => row.worker.id === id)?.worker;
  const worker: Worker = {
    // A previous run's record wins on everything that accrued — shift count,
    // journal anchors, this month's spend — and the file wins on everything
    // that describes the job. That split is the whole point of --state-dir.
    ...(existing ?? {}),
    id,
    name: portable.name,
    jobDescription: portable.jobDescription,
    projectPath,
    // Deliberately null, not `portable.cadence`: `arm()` would otherwise
    // schedule a second shift against a process that is about to exit.
    cadence: null,
    // --trust wins over a stored one: the job file is the declaration, and a
    // record left at probation by an earlier run must not outrank the flag the
    // pipeline now carries.
    trust: opts.trust,
    caps: {
      ...portable.caps,
      // `serializeWorker` forces worktree into the bundle, and CI usually
      // wants the checkout it was handed. --run-in is the override.
      runIn: opts.runIn ?? 'cwd',
    },
    budgetUSDPerMonth: portable.budgetUSDPerMonth,
    heartbeatModel: portable.heartbeatModel,
    heartbeatBackend: portable.heartbeatBackend,
    flowIds: portable.flowIds,
    mcpServers: portable.mcpServers,
    enabled: true,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveWorker(worker);
  engines.workerEngine.start();

  reporter.progress(`working a shift for ${worker.name} in ${projectPath}`);
  const shift = await engines.workerEngine.workShiftNow(id);
  if (!shift.ok) {
    return { ...summaryBase, workerId: id, status: 'shift-failed', error: shift.error };
  }

  const batch = await waitForWorkerBatch(engines, id, opts.timeoutSeconds);
  if (!batch) {
    return {
      ...summaryBase,
      workerId: id,
      status: 'timeout',
      exitCode: EXIT.TIMEOUT,
      error: `The shift did not finish within ${opts.timeoutSeconds}s.`,
      permissionDecisions: decisions.map(toDecisionSummary),
      warnings,
    };
  }

  const items = batch.items.map((i) => ({ id: i.candidate.title, status: i.status }));
  const parked = batch.items.filter((i) => i.status === 'proposed' || i.status === 'paused');
  const failed = batch.items.filter((i) => i.status === 'failed');
  const status = parked.length > 0 ? 'needs-human' : failed.length > 0 ? 'failed' : 'done';
  return {
    ...summaryBase,
    workerId: id,
    ok: status === 'done',
    status,
    exitCode:
      status === 'done' ? EXIT.OK : status === 'needs-human' ? EXIT.NEEDS_HUMAN : EXIT.RUN_FAILED,
    steps: items,
    artifacts: [],
    permissionDecisions: decisions.map(toDecisionSummary),
    warnings,
    error:
      parked.length > 0
        ? `${parked.length} item(s) are waiting for a human: ${parked.map((i) => i.candidate.title).join(', ')}`
        : failed.length > 0
          ? failed.map((i) => `${i.candidate.title}: ${i.note ?? 'failed'}`).join('; ')
          : undefined,
  };
}

function toDecisionSummary(d: PermissionDecision) {
  return { tool: d.toolName, approved: d.approved, reason: d.reason };
}

export function summariseRun(args: {
  run: FlowRun | null;
  flow: Flow;
  summaryBase: RunSummary;
  decisions: PermissionDecision[];
  warnings: string[];
  runId: string;
}): RunSummary {
  const { run, flow, summaryBase, decisions, warnings, runId } = args;
  const common = {
    ...summaryBase,
    flowId: flow.id,
    runId,
    permissionDecisions: decisions.map(toDecisionSummary),
    warnings,
  };
  if (!run) {
    return { ...common, status: 'timeout', exitCode: EXIT.TIMEOUT, error: 'The run did not reach a terminal state in time.' };
  }

  const steps = (run.flowSnapshot?.steps ?? []).map((s) => {
    const attempts = run.attempts.filter((a) => a.stepId === s.id);
    const last = attempts[attempts.length - 1];
    return { id: s.id, status: last?.outcome ?? 'not-run' };
  });
  const artifacts = Object.values(run.artifacts ?? {}).map((a) => ({ name: a.name }));

  if (run.state.kind === 'done') {
    return {
      ...common,
      ok: run.state.success,
      status: run.state.success ? 'done' : 'failed',
      exitCode: run.state.success ? EXIT.OK : EXIT.RUN_FAILED,
      steps,
      artifacts,
    };
  }
  if (run.state.kind === 'paused') {
    return {
      ...common,
      status: `paused:${run.state.reason}`,
      exitCode: EXIT.NEEDS_HUMAN,
      steps,
      artifacts,
      error: `The run stopped at ${run.state.nextStepId} and needs a human (${run.state.reason}).`,
    };
  }
  return {
    ...common,
    status: run.state.kind,
    exitCode: run.state.kind === 'aborted' ? EXIT.RUN_FAILED : EXIT.OK,
    steps,
    artifacts,
  };
}

/// Park until the run is terminal. `setRunObserver` is a single slot the
/// orchestrator already owns (see engines.ts), so this polls instead of
/// stealing it — the runtime writes every transition to its own store and
/// `getRun` is a map lookup, so the cost is nil next to a model turn.
function waitForRun(engines: HeadlessEngines, runId: string, timeoutSeconds: number): Promise<FlowRun | null> {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  return new Promise((resolve) => {
    const tick = () => {
      const run = engines.flowRuntime.getRun(runId);
      if (run) {
        const k = run.state.kind;
        // `paused` is terminal FOR US: nobody is going to press Continue.
        if (k === 'done' || k === 'aborted' || k === 'archived' || k === 'paused') {
          resolve(run);
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(run ?? null);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

/// How long to wait for a shift that never produced a batch before calling it
/// an empty shift. A planning turn is one model call; ten minutes is far past
/// generous and still finite.
const EMPTY_SHIFT_GRACE_MS = 10 * 60 * 1000;

interface SettledItem {
  candidate: { title: string };
  status: string;
  note?: string;
}

/// Is this item finished as far as a headless run is concerned?
///
/// The item's own status is not sufficient, and this is the subtle part. The
/// orchestrator parks an item when it sees the child run pause — but it looks
/// the item up by `runId`, and a run that pauses almost immediately (an
/// external-action step is the common case: the boundary stops it before the
/// first token) can transition BEFORE the launch path has recorded that id.
/// The update then finds no item and returns, the item stays `running`, and
/// nothing will ever move it again because moving it requires a human. A
/// waiter that trusted the status would hang until the CI timeout with the
/// answer already sitting in the run.
///
/// So the run is consulted directly when there is one, and it wins.
export function itemSettled(engines: HeadlessEngines, item: { status: string; runId?: string }): boolean {
  if (TERMINAL_ITEM.has(item.status)) return true;
  // `proposed` is a shift that parked for approval; `paused` is a run that
  // did. Both mean "waiting for a human", which headless is terminal.
  if (item.status === 'proposed' || item.status === 'paused') return true;
  if (!item.runId) return false;
  const run = engines.flowRuntime.getRun(item.runId);
  if (!run) return false;
  const kind = run.state.kind;
  return kind === 'done' || kind === 'aborted' || kind === 'archived' || kind === 'paused';
}

/// Fold the authoritative run state back onto the item, so the summary reports
/// what actually happened rather than the status the batch last managed to
/// write. Same race as `itemSettled`.
function reconcileItem(engines: HeadlessEngines, item: SettledItem & { runId?: string }): SettledItem {
  if (TERMINAL_ITEM.has(item.status) || item.status === 'proposed') return item;
  const run = item.runId ? engines.flowRuntime.getRun(item.runId) : null;
  if (!run) return item;
  if (run.state.kind === 'done') {
    return { ...item, status: run.state.success ? 'done' : 'failed' };
  }
  if (run.state.kind === 'aborted') return { ...item, status: 'failed', note: item.note ?? 'Run aborted.' };
  if (run.state.kind === 'paused') {
    return {
      ...item,
      status: 'paused',
      note: item.note ?? `stopped at ${run.state.nextStepId} (${run.state.reason})`,
    };
  }
  return item;
}

function waitForWorkerBatch(
  engines: HeadlessEngines,
  workerId: string,
  timeoutSeconds: number,
): Promise<{ items: SettledItem[] } | null> {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const batches = engines.orchestrator
        .list()
        .filter((o) => o.origin?.kind === 'worker' && o.origin.workerId === workerId);
      const batch = batches.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (batch) {
        if (batch.items.every((i) => itemSettled(engines, i))) {
          resolve({ items: batch.items.map((i) => reconcileItem(engines, i)) });
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve(batch ? { items: batch.items.map((i) => reconcileItem(engines, i)) } : null);
        return;
      }
      // A shift that proposes nothing never creates a batch. Report the empty
      // shift rather than hanging until the CI timeout.
      if (!batch && Date.now() - startedAt > EMPTY_SHIFT_GRACE_MS) {
        resolve({ items: [] });
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

/// Turn the event firehose into a line a person reading CI logs can use. Most
/// event types say nothing at this altitude and are dropped on purpose — a
/// headless run that echoed every token would bury its own failure.
function reportEvent(event: MainToRendererEvent, reporter: Reporter): void {
  if (event.type === 'flowRunUpdate') {
    const run = event.run;
    if (run.state.kind === 'running') reporter.progress(`step ${run.state.currentStepId}`, { runId: run.id });
    else if (run.state.kind === 'paused') {
      reporter.progress(`paused at ${run.state.nextStepId} (${run.state.reason})`, { runId: run.id });
    } else if (run.state.kind === 'done') {
      reporter.progress(run.state.success ? 'run finished' : 'run finished with a failure', { runId: run.id });
    }
  }
}

/// Copy the run's recorded artifacts out of the state directory so the job can
/// upload them. Written as files named after the artifact, because the
/// pipeline step that consumes this is `upload-artifact: path: out`.
export function writeArtifacts(dir: string, run: FlowRun | null): string[] {
  if (!run) return [];
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const art of Object.values(run.artifacts ?? {})) {
    if (!art.body) continue;
    const safe = art.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'artifact';
    const target = path.join(dir, safe);
    fs.writeFileSync(target, art.body, 'utf-8');
    written.push(target);
  }
  return written;
}
