// A whole org in one file, to move it to another server: every worker, team
// and process, with what each worker has learned and done.
//
// Not a share. A share goes to someone else's org, so what lands is a hire on
// probation. A bundle is an admin moving their own org, so trust, managers and
// who reports to whom come along (see `OrgService.importOrg` for when).
//
// Never in a bundle: a secret value. Tools travel as their setup with every
// key removed, as in any worker file; webhook triggers get new addresses,
// since a webhook's token is a secret too; and org.json stays with the
// server's own deploy files.

import type { WorkerManager, WorkerTrustLevel, WorkerVisibility } from '../../shared/flows/worker';
import type { OrgImportReport } from '../../shared/org/orgImport';

export type { OrgImportReport };
import { isSlackUserId } from '../../shared/flows/worker';
import type { ProcessPerson, ProcessStage } from '../../shared/org/process';
import { parseTemplates, type ToolTemplate } from './tools';
import { personInput, stagesInput } from './processInput';

export const ORG_BUNDLE_FORMAT = 'overgo-org';
export const ORG_BUNDLE_VERSION = 1;
export const ORG_BUNDLE_LIMITS = { workers: 500, teams: 200, processes: 200, workerFile: 8_000_000 };

export interface OrgBundleWorker {
  /// Its id where it came from; the server remembers it, so importing again
  /// finds it rather than hiring it twice.
  sourceId: string;
  /// Its worker file, with its triggers, tool scopes, what it knows, its
  /// notes and its journal (`WorkerCarried`).
  yaml: string;
  /// Its tools' setup minus every value, for the Tools page to offer.
  tools?: ToolTemplate[];
  trust: WorkerTrustLevel;
  enabled: boolean;
  manager?: WorkerManager;
  /// The `sourceId` of the worker it reports to.
  reportsTo?: string;
  visibility?: WorkerVisibility;
}

export interface OrgBundleTeam {
  sourceId: string;
  name: string;
  purpose?: string;
  budgetUSDPerTask: number;
  checkpoints?: Record<string, boolean>;
  piecesAskFirst?: boolean;
  members: Array<{ sourceId: string; role: string }>;
}

/// A process's stages name their team or worker by its `sourceId`.
export interface OrgBundleProcess {
  sourceId: string;
  name: string;
  purpose?: string;
  owner?: ProcessPerson;
  access?: unknown;
  stages: Array<Omit<ProcessStage, 'teamId' | 'workerId' | 'trusted'> & { sourceTeamId?: string; sourceWorkerId?: string }>;
}

/// The org's setup, with no secret value in it. `rules`: org.json's rules
/// (budgets, allowances, approvers, groups, roles, tool defaults, capacity,
/// retention, model ids) without who the server is (name, address, sign-in,
/// other servers) or who its admins are. Databases and APIs are as overdb and
/// overapi publish them: the variables a password goes in, never the value.
export interface OrgBundleSetup {
  rules?: Record<string, unknown>;
  handbook?: string;
  tools?: ToolTemplate[];
  repos?: Array<{ name: string; url: string }>;
  workspaces?: Array<{ name: string; repos: string[]; instructions?: string }>;
  databases?: unknown[];
  apis?: unknown[];
}

/// Rules that travel. Everything EDITABLE_RULES has, but who the server is.
export const PORTABLE_RULES = [
  'timezone', 'hirers', 'budgetAllowanceUSD', 'otherPeopleLimitUSD', 'approvers', 'orgVisibilityNeedsAdmin', 'tuningWatch', 'webNeedsApproval', 'webFetch',
  'ownDomains', 'serviceAccounts', 'allowedMcpServers', 'sharedMcpServers', 'teams', 'roles', 'orgBudgetUSD', 'alertAtPercent', 'prSavedMultiplier',
  'prSavedMinHours', 'retentionDays', 'people', 'answersAtOnce', 'codeRunsAtOnce', 'redactSecrets', 'providerModels', 'workerAccess',
] as const;

/// A repo's address with any name or password taken out of it.
export function bareRepoUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

export interface OrgBundle {
  format: typeof ORG_BUNDLE_FORMAT;
  version: typeof ORG_BUNDLE_VERSION;
  exportedAt: number;
  source: { kind: 'desktop' | 'server'; org?: string; slackTeamId?: string };
  workers: OrgBundleWorker[];
  teams: OrgBundleTeam[];
  processes: OrgBundleProcess[];
  setup?: OrgBundleSetup;
}

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRUST: readonly WorkerTrustLevel[] = ['probation', 'trusted', 'autonomous'];
const VISIBILITY: readonly WorkerVisibility[] = ['private', 'team', 'org'];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function managerOf(raw: unknown): WorkerManager | undefined {
  const m = obj(raw);
  const name = str(m?.name, 120);
  if (!name) return undefined;
  const id = typeof m?.slackUserId === 'string' && isSlackUserId(m.slackUserId) ? m.slackUserId : undefined;
  return { name, ...(id ? { slackUserId: id } : {}) };
}

/// A bundle read from a file someone handed in: every field checked, every
/// list capped, anything unknown dropped. The worker files inside are read
/// again when each lands.
export function parseOrgBundle(raw: unknown): { ok: true; bundle: OrgBundle } | { ok: false; error: string } {
  const b = obj(raw);
  if (!b || b.format !== ORG_BUNDLE_FORMAT) return { ok: false, error: 'That is not an org file: export one with overcli org export, or Settings → Your org.' };
  if (b.version !== ORG_BUNDLE_VERSION) return { ok: false, error: `That org file is version ${String(b.version)}; this server reads version ${ORG_BUNDLE_VERSION}. Update the server, then import it.` };
  const src = obj(b.source);
  const slackTeamId = typeof src?.slackTeamId === 'string' && /^[TE][A-Z0-9]{6,}$/.test(src.slackTeamId) ? src.slackTeamId : undefined;
  const source: OrgBundle['source'] = {
    kind: src?.kind === 'server' ? 'server' : 'desktop',
    ...(str(src?.org, 120) ? { org: str(src?.org, 120) } : {}),
    ...(slackTeamId ? { slackTeamId } : {}),
  };
  const list = (v: unknown, max: number, what: string): unknown[] | string => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return `Its ${what} aren't a list.`;
    if (v.length > max) return `It has ${v.length} ${what}; one import takes ${max} at most.`;
    return v;
  };
  const rawWorkers = list(b.workers, ORG_BUNDLE_LIMITS.workers, 'workers');
  const rawTeams = list(b.teams, ORG_BUNDLE_LIMITS.teams, 'teams');
  const rawProcesses = list(b.processes, ORG_BUNDLE_LIMITS.processes, 'processes');
  for (const l of [rawWorkers, rawTeams, rawProcesses]) if (typeof l === 'string') return { ok: false, error: l };

  const workers: OrgBundleWorker[] = [];
  const seen = new Set<string>();
  for (const x of rawWorkers as unknown[]) {
    const w = obj(x);
    const sourceId = typeof w?.sourceId === 'string' && SOURCE_ID.test(w.sourceId) ? w.sourceId : '';
    if (!w || !sourceId || seen.has(sourceId)) return { ok: false, error: 'A worker in it has no id, or the same id as another.' };
    if (typeof w.yaml !== 'string' || !w.yaml.trim() || w.yaml.length > ORG_BUNDLE_LIMITS.workerFile) return { ok: false, error: 'A worker in it has no worker file, or one too large.' };
    seen.add(sourceId);
    const manager = managerOf(w.manager);
    const reportsTo = typeof w.reportsTo === 'string' && SOURCE_ID.test(w.reportsTo) ? w.reportsTo : undefined;
    const tools = parseTemplates(w.tools);
    workers.push({
      sourceId,
      yaml: w.yaml,
      ...(tools.length ? { tools } : {}),
      trust: TRUST.includes(w.trust as WorkerTrustLevel) ? (w.trust as WorkerTrustLevel) : 'probation',
      enabled: w.enabled !== false,
      ...(manager ? { manager } : {}),
      ...(reportsTo ? { reportsTo } : {}),
      ...(VISIBILITY.includes(w.visibility as WorkerVisibility) ? { visibility: w.visibility as WorkerVisibility } : {}),
    });
  }
  // Reporting lines only to workers that came with it.
  for (const w of workers) if (w.reportsTo && (!seen.has(w.reportsTo) || w.reportsTo === w.sourceId)) delete w.reportsTo;

  const teams: OrgBundleTeam[] = [];
  for (const x of rawTeams as unknown[]) {
    const t = obj(x);
    const sourceId = typeof t?.sourceId === 'string' && SOURCE_ID.test(t.sourceId) ? t.sourceId : '';
    const name = str(t?.name, 120);
    if (!t || !sourceId || !name) return { ok: false, error: 'A team in it has no id or no name.' };
    const members = Array.isArray(t.members)
      ? t.members.flatMap((m) => {
          const mm = obj(m);
          const id = typeof mm?.sourceId === 'string' && SOURCE_ID.test(mm.sourceId) ? mm.sourceId : '';
          return id ? [{ sourceId: id, role: str(mm?.role, 200) }] : [];
        })
      : [];
    const budget = typeof t.budgetUSDPerTask === 'number' && Number.isFinite(t.budgetUSDPerTask) && t.budgetUSDPerTask > 0 ? t.budgetUSDPerTask : 5;
    const checkpoints = obj(t.checkpoints);
    teams.push({
      sourceId,
      name,
      ...(str(t.purpose, 2000) ? { purpose: str(t.purpose, 2000) } : {}),
      budgetUSDPerTask: budget,
      ...(checkpoints ? { checkpoints: Object.fromEntries(Object.entries(checkpoints).filter((e): e is [string, boolean] => typeof e[1] === 'boolean').slice(0, 20)) } : {}),
      ...(t.piecesAskFirst === false ? { piecesAskFirst: false } : {}),
      members: members.slice(0, 20),
    });
  }

  const processes: OrgBundleProcess[] = [];
  for (const x of rawProcesses as unknown[]) {
    const p = obj(x);
    const sourceId = typeof p?.sourceId === 'string' && SOURCE_ID.test(p.sourceId) ? p.sourceId : '';
    const name = str(p?.name, 120);
    if (!p || !sourceId || !name) return { ok: false, error: 'A process in it has no id or no name.' };
    const raw = Array.isArray(p.stages) ? (p.stages as unknown[]) : [];
    // Read as a form's stages are, then given back their source ids.
    const stages = stagesInput(raw).map((st, i) => {
      const r = obj(raw[i]);
      const { teamId: _t, workerId: _w, ...rest } = st;
      const team = typeof r?.sourceTeamId === 'string' && SOURCE_ID.test(r.sourceTeamId) ? r.sourceTeamId : undefined;
      const worker = typeof r?.sourceWorkerId === 'string' && SOURCE_ID.test(r.sourceWorkerId) ? r.sourceWorkerId : undefined;
      return { ...rest, ...(st.kind === 'team' && team ? { sourceTeamId: team } : {}), ...(st.kind === 'worker' && worker ? { sourceWorkerId: worker } : {}) };
    });
    const owner = personInput(p.owner);
    processes.push({
      sourceId,
      name,
      ...(str(p.purpose, 1000) ? { purpose: str(p.purpose, 1000) } : {}),
      ...(owner ? { owner } : {}),
      ...(p.access !== undefined ? { access: p.access } : {}),
      stages,
    });
  }

  const setup = parseSetup(b.setup);
  return {
    ok: true,
    bundle: {
      ...(setup ? { setup } : {}),
      format: ORG_BUNDLE_FORMAT,
      version: ORG_BUNDLE_VERSION,
      exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : 0,
      source,
      workers,
      teams,
      processes,
    },
  };
}

/// The setup section, shapes checked and lists capped. Rules are checked
/// again by the rules page's own checks as they land, databases and APIs by
/// overdb's and overapi's parsers.
function parseSetup(raw: unknown): OrgBundleSetup | undefined {
  const s = obj(raw);
  if (!s) return undefined;
  const out: OrgBundleSetup = {};
  const rules = obj(s.rules);
  if (rules) {
    const kept = Object.fromEntries(Object.entries(rules).filter(([k]) => (PORTABLE_RULES as readonly string[]).includes(k)));
    if (Object.keys(kept).length) out.rules = kept;
  }
  if (typeof s.handbook === 'string' && s.handbook.trim()) out.handbook = s.handbook.slice(0, 50_000);
  const tools = parseTemplates(s.tools);
  if (tools.length) out.tools = tools.slice(0, 200);
  if (Array.isArray(s.repos)) {
    const repos = s.repos.flatMap((r) => {
      const o = obj(r);
      const name = str(o?.name, 120);
      const url = str(o?.url, 500);
      return name && url ? [{ name, url: bareRepoUrl(url) }] : [];
    });
    if (repos.length) out.repos = repos.slice(0, 500);
  }
  if (Array.isArray(s.workspaces)) {
    const ws = s.workspaces.flatMap((w) => {
      const o = obj(w);
      const name = str(o?.name, 120);
      const repos = Array.isArray(o?.repos) ? (o!.repos as unknown[]).map((r) => str(r, 120)).filter(Boolean).slice(0, 50) : [];
      const instructions = str(o?.instructions, 20_000);
      return name && repos.length ? [{ name, repos, ...(instructions ? { instructions } : {}) }] : [];
    });
    if (ws.length) out.workspaces = ws.slice(0, 200);
  }
  if (Array.isArray(s.databases) && s.databases.length) out.databases = s.databases.slice(0, 200);
  if (Array.isArray(s.apis) && s.apis.length) out.apis = s.apis.slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}

/// A file name for a bundle: `acme-org-2026-11-16.json`.
export function orgBundleFilename(org: string | undefined, at: number): string {
  const slug = (org ?? 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
  return `${slug}-org-${new Date(at).toISOString().slice(0, 10)}.json`;
}
