// Build the team engine over the other engines — shared by the app and
// `overcli serve`, so a team task runs the same on a desktop and on the org's
// box. Moved out of index.ts, unchanged, for that reason.

import os from 'node:os';
import type { MainToRendererEvent, UUID } from '../../shared/types';
import type { Worker } from '../../shared/flows/worker';
import { sourceFlowIdOfPiece, withStepTools, type TeamHireRequest } from '../../shared/flows/team';
import { loadAllFlows, saveFlow } from './storage';
import { pickDrafterBackend, resolveProducerModel } from '../../shared/flows/drafterBackend';
import { healthyBackends } from '../health';
import type { RunnerManager } from '../runner';
import { Store } from '../store';
import { looseSyntheticRootFiles } from '../workspace';
import { oneShotDraftText, type DraftDeps } from './drafter';
import type { FlowRuntimeImpl } from './runtime';
import type { FlowRun } from '../../shared/flows/schema';
import { stepOutsideTools } from './stepEffect';
import type { OrchestratorImpl } from './orchestrator';
import { loadRunSummaries } from './runSummaryLog';
import { TeamEngine } from './teamEngine';
import {
  absorbPiece,
  closeTaskBranch,
  landTaskBranch,
  openTaskBranch,
  pushTaskBranch,
  restoreTaskBranch,
  taskBranchAhead,
  taskRepos,
} from './teamBranch';
import type { WorkerEngine } from './workerEngine';

/// A run's deliverables: its step artifacts in step order (the answer last),
/// plus the files it wrote into a synthetic root. Shared by workers, which
/// file them into a cabinet, and teams, which file them into a task folder.
/// What a paused run is waiting on you for, as the end of "<member> …";
/// null when it isn't paused, or is held because you paused its batch.
export function describeRunPause(run: Pick<FlowRun, 'state' | 'flowSnapshot'> | null): string | null {
  if (!run || run.state.kind !== 'paused') return null;
  const { reason, nextStepId } = run.state;
  const step = run.flowSnapshot?.steps.find((s) => s.id === nextStepId);
  switch (reason) {
    case 'externalAction': {
      const tools = step ? stepOutsideTools(step) : null;
      return tools?.length
        ? `wants your OK to use ${tools.join(', ')}${step ? ` for "${step.id}"` : ''}`
        : `wants your OK before "${step?.id ?? nextStepId}", which reaches outside`;
    }
    case 'riskyStep':
      return `stopped before "${step?.id ?? nextStepId}": its instructions look risky, so look first`;
    case 'needsInput':
      return 'has a question for you';
    case 'preStep':
      return `is at a checkpoint before "${step?.id ?? nextStepId}"`;
    case 'failure':
      return 'hit a failure and stopped';
    case 'interrupted':
      return 'was interrupted when the app closed: continue it';
    case 'held':
      return null;
  }
}

export function runDeliverablesFor(
  getRun: (runId: UUID) => ReturnType<FlowRuntimeImpl['getRun']>,
): (runId: UUID) => Array<{ name: string; body?: string; sourcePath?: string; bytes?: number }> {
  return (runId) => {
    const run = getRun(runId);
    if (!run) return [];
    // Step order, so the answer is last and its supporting material reads in
    // the order it was produced.
    const seen = new Set<string>();
    const out: Array<{ name: string; body?: string; sourcePath?: string; bytes?: number }> = [];
    for (const step of run.flowSnapshot?.steps ?? []) {
      const art = run.artifacts?.[step.output];
      if (!art || seen.has(art.name)) continue;
      seen.add(art.name);
      out.push({ name: art.name, body: art.body });
    }
    // Plus whatever the run WROTE rather than recorded. A step told to
    // render a dashboard or a chart writes a real file into its working
    // root and hands back a receipt — the receipt is the artifact, so
    // filing artifacts alone kept the note and dropped the thing it
    // described, which then died with the run's coordinator root.
    for (const file of looseSyntheticRootFiles(run.projectPath, {
      since: run.createdAt,
    })) {
      if (seen.has(file.name)) continue;
      seen.add(file.name);
      out.push({ name: file.name, sourcePath: file.path, bytes: file.bytes });
    }
    return out;
  };
}

export function createTeamEngine(deps: {
  emit: (event: MainToRendererEvent) => void;
  notify: (args: { title: string; body: string }) => void;
  runner: RunnerManager;
  flowRuntime: Pick<FlowRuntimeImpl, 'getRun' | 'steerRun'>;
  orchestrator: Pick<OrchestratorImpl, 'get' | 'abort'>;
  workerEngine: WorkerEngine;
  drafterDeps: () => DraftDeps;
  hire?: (req: TeamHireRequest) => Promise<{ ok: true; worker: Worker } | { ok: false; error: string }>;
}): TeamEngine {
  const { runner, flowRuntime, orchestrator, workerEngine } = deps;
  return new TeamEngine({
    emit: deps.emit,
    notify: deps.notify,
    workers: () => workerEngine.list().map((entry) => entry.worker),
    commission: (workerId, args) => workerEngine.commission(workerId, args),
    batch: (id) => orchestrator.get(id) ?? null,
    coordinatorTurn: async ({ system, message, cancelKey, onProgress, attachments }) => {
      const res = await oneShotDraftText(deps.drafterDeps(), {
        buildSystemPrompt: () => system,
        userMessage: message,
        ...(attachments?.length ? { attachments } : {}),
        verb: 'coordinate the team',
        cancelKey,
        onProgress,
        // A coordinator turn reads every member's piece before it writes a
        // word, on the strongest model, so minutes of silence is normal. The
        // ceilings are only a backstop against a turn that has truly hung.
        timeouts: { timeoutMs: 45 * 60_000, idleTimeoutMs: 15 * 60_000 },
        // It is told it has no tools, but if it reaches for one anyway a
        // hidden turn must never sit on a permission prompt nobody can see.
        permissionMode: 'plan',
      });
      return res.ok ? { ok: true, text: res.text } : res;
    },
    cancelTurn: (cancelKey) => {
      runner.cancelOneShot(cancelKey);
    },
    steer: (runId, text) => flowRuntime.steerRun({ runId, text }),
    pauseOf: (runId) => describeRunPause(flowRuntime.getRun(runId)),
    refusedOf: (runId) => {
      const run = flowRuntime.getRun(runId);
      return run?.refusedTools?.length ? { tools: run.refusedTools, flowId: sourceFlowIdOfPiece(run.flowId) } : null;
    },
    allowTools: (flowId, tools) => {
      const flow = loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }).find((f) => f.id === flowId);
      if (!flow) return { ok: false, error: `The flow "${flowId}" is gone.` };
      // A project flow lives in its repo; changing it is a commit, not a click.
      if (flow.source === 'project') return { ok: false, error: `"${flow.name}" is a project flow. Add ${tools.join(', ')} to it in the flow editor.` };
      const next = withStepTools(flow, tools);
      if (!next) return { ok: true };
      // A generated flow saved as yours shadows the original (loadAllFlows).
      const saved = saveFlow({ flow: next, target: 'user' });
      return saved.ok ? { ok: true } : saved;
    },
    cancelBatch: (id) => {
      orchestrator.abort({ id });
    },
    // Away mode holds team stages too; coming back reaches the engine as
    // the `workersAway` event through the host's emit.
    crewAway: () => !!workerEngine.awayState(),
    // A member speaking in the room runs on ITS OWN backend and model — the
    // point of a Codex challenger is that Codex is the one answering. Same
    // backend resolution as the worker supervisor; plan mode so a stray tool
    // call reads or is refused rather than waiting on a prompt nobody sees.
    memberTurn: async ({ worker, prompt, cancelKey, onProgress, attachments }) => {
      const settings = Store.load().settings;
      const healthy = await healthyBackends(settings.backendPaths);
      const backend = pickDrafterBackend({
        preferred: worker.heartbeatBackend ?? settings.preferredBackend,
        isHealthy: (candidate) => healthy.has(candidate),
        isEnabled: (candidate) => settings.disabledBackends[candidate] !== true,
      });
      if (!backend) return { ok: false, error: `No signed-in model is available for ${worker.name}.` };
      const res = await runner.oneShot({
        backend,
        model: resolveProducerModel(backend, worker.heartbeatModel, settings.flowModelDefaults),
        prompt,
        ...(attachments?.length ? { attachments } : {}),
        cwd: os.homedir(),
        permissionMode: 'plan',
        skipGlobalMcp: true,
        cancelKey,
        ...(onProgress ? { onProgress: (snap: { text: string }) => onProgress(snap.text) } : {}),
        timeoutMs: 20 * 60_000,
        idleTimeoutMs: 10 * 60_000,
      });
      return res.ok ? { ok: true, text: res.text } : res;
    },
    deliverablesFor: runDeliverablesFor((id) => flowRuntime.getRun(id)),
    ...(deps.hire ? { hire: deps.hire } : {}),
    // One branch per team task across the repos it works in; see teamBranch.
    code: {
      open: ({ taskId, title, projectPath, from }) => {
        const store = Store.load();
        const byId = new Map(store.projects.map((p) => [p.id, p.path]));
        const workspaces = store.workspaces.map((w) => ({
          rootPath: w.rootPath,
          memberPaths: w.projectIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
        }));
        return openTaskBranch({ taskId, title, repos: taskRepos(projectPath, workspaces), ...(from ? { from } : {}) });
      },
      pieceRepos: (runId) => {
        const run = flowRuntime.getRun(runId);
        if (!run) return [];
        if (run.workspaceWorktrees?.length) {
          return run.workspaceWorktrees.map((m) => ({
            projectPath: m.projectPath,
            worktreePath: m.worktreePath,
            branchName: m.branchName,
            startedAt: run.createdAt,
          }));
        }
        return run.worktreePath && run.branchName
          ? [
              {
                projectPath: run.sourceProjectPath ?? run.projectPath,
                worktreePath: run.worktreePath,
                branchName: run.branchName,
                startedAt: run.createdAt,
              },
            ]
          : [];
      },
      absorb: (args) => absorbPiece(args),
      land: (code, repo, subject) => landTaskBranch(code, repo, subject),
      push: (code, repo, subject) => pushTaskBranch(code, repo, subject),
      ahead: (code) => taskBranchAhead(code),
      restore: (code) => restoreTaskBranch(code),
      close: (code) => closeTaskBranch(code),
    },
    projects: () => {
      const store = Store.load();
      // Workspaces first, as the hire drafter lists them.
      return [
        ...store.workspaces.map((w) => ({ name: w.name, path: w.rootPath })),
        ...store.projects.map((p) => ({ name: p.name, path: p.path })),
      ];
    },
    spendForRuns: (runIds) => {
      const wanted = new Set(runIds);
      let total = 0;
      for (const s of loadRunSummaries()) if (wanted.has(s.id)) total += s.costUSD;
      return total;
    },
  });
}
