// Draft a hire and make it, with nobody at the review screen.
//
// Two callers share this: a team hiring for a role (index.ts), and the org
// control plane hiring for a person who asked in Slack or over MCP. Both get
// the same contract from the same drafter, and both land the worker the same
// way — on demand, on probation, with no browser and only the connectors the
// caller explicitly clears. Lives outside index.ts so `overcli serve` can hire
// without Electron on its import graph.

import { scanCapabilities } from '../capabilities';
import { draftWorkerFromPrompt } from '../flows/workerDrafter';
import type { DraftDeps } from '../flows/drafter';
import type { RunnerManager } from '../runner';
import type { WorkerEngine } from '../flows/workerEngine';
import { loadAllFlows, saveFlow } from '../flows/storage';
import { loadRunSummaries } from '../flows/runSummaryLog';
import { renderProvenFlowsSection } from '../flows/provenFlows';
import { seenMcpTools } from '../flows/mcpToolCache';
import { ensureMcpSeen } from '../flows/mcpProbe';
import { resolveBackendPath } from '../health';
import { log } from '../diagnostics';
import { Store } from '../store';
import { isEverydayProject } from '../../shared/everydayProjects';
import { renameIfTaken } from '../../shared/flows/team';
import type { HireMessage, Worker, WorkerContract } from '../../shared/flows/worker';

export function drafterDepsFor(runner: RunnerManager): DraftDeps {
  const store = Store.load();
  return {
    settings: store.settings,
    runner,
    mcpTools: seenMcpTools(),
    provenFlows: renderProvenFlowsSection(
      loadAllFlows({ projectPaths: store.projects.map((p) => p.path) }),
      loadRunSummaries(),
    ),
  };
}

/// What the hire drafter is shown about this install: the flows it can
/// route to, the projects a job can land in, the MCP servers it can grant,
/// and the crew's names so a new one never collides.
export async function hireDraftContext(crew: string[]) {
  const store = Store.load();
  // The drafter's own turns run strict and report no servers, so a user who
  // comes straight here may have none recorded. Ask Claude once — it costs
  // no model call (see mcpProbe) and only happens while the record is empty.
  await ensureMcpSeen(resolveBackendPath('claude', store.settings.backendPaths.claude));
  // The same servers the editor's picker offers. A failed scan means the
  // drafter is not asked to choose, and the worker loads everything.
  let mcpServers: string[] | undefined;
  try {
    const report = scanCapabilities();
    mcpServers = Array.from(
      new Set([
        ...report.entries.filter((e) => e.kind === 'mcp' && e.clis.includes('claude')).map((e) => e.name),
        ...(report.accountConnectors ?? []),
      ]),
    ).sort((a, b) => a.localeCompare(b));
  } catch (err) {
    log('warn', 'workers.hire', 'MCP scan for the hire drafter failed', err);
  }
  return {
    mcpServers,
    crew,
    flows: loadAllFlows({
      projectPaths: store.projects.map((p) => p.path),
    }).map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
    })),
    // Workspaces first: a job that names one should land on the whole
    // workspace, not one member repo that happens to share the name.
    projects: [
      ...store.workspaces.map((w) => ({
        name: w.name,
        path: w.rootPath,
        kind: 'workspace' as const,
      })),
      ...store.projects.map((p) => ({
        name: p.name,
        path: p.path,
        kind: 'project' as const,
      })),
    ],
  };
}

export type DraftedHire = Extract<Awaited<ReturnType<typeof draftWorkerFromPrompt>>, { contract: WorkerContract }>;

export type HireDraftResult =
  | { ok: true; kind: 'drafted'; drafted: DraftedHire }
  | { ok: true; kind: 'questions'; questions: string[] }
  | { ok: false; error: string };

/// One drafter turn. In interview mode it may come back with questions.
export async function draftHire(
  args: { runner: RunnerManager; crew: string[]; jobDescription: string; conversation?: HireMessage[]; interview: boolean },
): Promise<HireDraftResult> {
  const drafted = await draftWorkerFromPrompt(
    {
      ...(await hireDraftContext(args.crew)),
      jobDescription: args.jobDescription,
      conversation: args.conversation,
      interview: args.interview,
      polish: false,
    },
    drafterDepsFor(args.runner),
  );
  if (!drafted.ok) return drafted;
  if (!('contract' in drafted)) {
    const questions = drafted.questions?.length ? drafted.questions.map((q) => q.question) : [drafted.question];
    return { ok: true, kind: 'questions', questions };
  }
  return { ok: true, kind: 'drafted', drafted };
}

/// Save a drafted hire as a worker: its new flows first, then the worker.
export function saveDraftedHire(
  engine: Pick<WorkerEngine, 'save' | 'workerNames'>,
  drafted: DraftedHire,
  opts: {
    projectPath?: string;
    /// Connectors the caller cleared. Absent here means NONE — an explicit
    /// empty list — never the load-everything default an absent field means
    /// on a worker: nobody reviewed this hire.
    mcpServers?: string[];
    extra?: Partial<Pick<Worker, 'manager' | 'reportsTo' | 'visibility' | 'avatarUrl' | 'hiredFor'>>;
    budgetUSDPerMonth?: number;
    /// When it runs. Absent: on demand, which is what a team's hire wants —
    /// the team commissions it. An org hire passes the drafter's schedule,
    /// or the one the person picked on the offer.
    cadence?: Worker['cadence'];
  },
): { ok: true; worker: Worker } | { ok: false; error: string } {
  // Checked against the crew as it is NOW, not as the drafter saw it: a hire
  // drafted alongside this one may have just taken the same name. Nothing
  // below awaits before the save, so no other hire can land in between.
  const contract = renameIfTaken(drafted.contract, engine.workerNames());
  const flows = drafted.flowPlan.filter((p) => p.flowId);
  if (flows.length === 0) {
    return { ok: false, error: `No flow for ${contract.name}: ${drafted.flowError ?? 'the drafter named none.'}` };
  }
  // A drafted flow is new; it saves where the hire screen saves one. The
  // wrap-up is left out: it combines a shift's items, and this worker has
  // no shifts.
  for (const p of flows) {
    if (!p.flow) continue;
    const saved = saveFlow({ flow: p.flow, target: 'user' });
    if (!saved.ok) return { ok: false, error: `Could not save ${contract.name}'s flow: ${saved.error}` };
  }
  const store = Store.load();
  const projectPath = opts.projectPath ?? contract.projectPath ?? store.workspaces[0]?.rootPath ?? store.projects[0]?.path;
  if (!projectPath) {
    return { ok: false, error: 'This server has no project for workers to work in. An operator can add one with: overcli projects add <folder>' };
  }
  const everyday = store.projects.find((p) => p.path === projectPath)?.everyday;
  return engine.save({
    name: contract.name,
    ...(contract.tagline?.trim() ? { tagline: contract.tagline.trim() } : {}),
    ...(contract.errandStarters?.length ? { errandStarters: contract.errandStarters } : {}),
    jobDescription: contract.jobDescription,
    projectPath,
    cadence: opts.cadence ?? null,
    caps: {
      maxItemsPerShift: contract.maxItemsPerShift,
      runIn: 'worktree',
      allowExternalActions: false,
      canDelegate: false,
      fileIntoProject: isEverydayProject({ path: projectPath, everyday }),
    },
    budgetUSDPerMonth: opts.budgetUSDPerMonth ?? contract.budgetUSDPerMonth,
    heartbeatModel: contract.heartbeatModel,
    heartbeatBackend: contract.heartbeatBackend,
    flowIds: flows.map((p) => p.flowId),
    // No browser, whatever the drafter picked: it reaches past the worktree
    // with your sign-ins, and is yours to tick on the worker yourself.
    mcpServers: opts.mcpServers ?? [],
    ...opts.extra,
    enabled: true,
  });
}
