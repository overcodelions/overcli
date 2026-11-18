// Moving a whole org: the org's workers and teams (OrgService) and its
// processes (ProcessService), out to one file and in again. The org server's
// control plane, the desktop app and `overcli org export|import` all come
// through here. See orgBundle.ts for what a bundle carries and never carries.

import type { OrgCaller } from '../../shared/org/policy';
import type { ProcessDef, ProcessPerson, ProcessStage } from '../../shared/org/process';
import type { OrgService } from './orgService';
import type { ProcessService } from './processes';
import { PORTABLE_RULES, orgBundleFilename, type OrgBundle, type OrgBundleProcess, type OrgBundleSetup, type OrgImportReport } from './orgBundle';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type Processes = Pick<ProcessService, 'list' | 'save'>;
/// The rules page (accessService.ts): rules travel through its checks.
type Rules = { rules(c: OrgCaller): Result<{ rules: object }>; setRules(c: OrgCaller, patch: Record<string, unknown>): Result };

const RULE_LABEL: Record<string, string> = {
  timezone: 'Time zone', hirers: 'Who may hire', budgetAllowanceUSD: 'Hiring allowance', otherPeopleLimitUSD: 'Limit on workers for other people', approvers: 'Hire approvers',
  orgVisibilityNeedsAdmin: 'Org-wide workers need an admin', tuningWatch: 'Tuning watch', webNeedsApproval: 'Web pages need approval', webFetch: 'Web fetching',
  ownDomains: 'Company domains', serviceAccounts: 'Service accounts', allowedMcpServers: 'Cleared tools', sharedMcpServers: 'Shared tools', teams: 'Groups',
  roles: 'Role catalog', orgBudgetUSD: 'Monthly org budget', alertAtPercent: 'Budget alert', prSavedMultiplier: 'Time saved per pull request', prSavedMinHours: 'Least time saved per pull request',
  retentionDays: 'Records kept', people: 'People by email', answersAtOnce: 'Answers at once', codeRunsAtOnce: 'Code runs at once', redactSecrets: 'Secrets kept out of answers',
  providerModels: 'Model ids', workerAccess: 'Worker permissions',
};

/// A process as it goes in a bundle: its stages name their team or worker by
/// the id it has here, which the importing server maps to its own copy.
export function bundleProcess(def: Pick<ProcessDef, 'id' | 'name' | 'purpose' | 'owner' | 'stages' | 'access'>): OrgBundleProcess {
  return {
    sourceId: def.id,
    name: def.name,
    ...(def.purpose ? { purpose: def.purpose } : {}),
    owner: { ...def.owner },
    ...(def.access ? { access: structuredClone(def.access) } : {}),
    stages: def.stages.map(({ teamId, workerId, trusted: _server, ...rest }) => ({
      ...structuredClone(rest),
      ...(rest.kind === 'team' && teamId ? { sourceTeamId: teamId } : {}),
      ...(rest.kind === 'worker' && workerId ? { sourceWorkerId: workerId } : {}),
    })),
  };
}

export function exportOrgBundle(
  org: Pick<OrgService, 'exportOrg' | 'exportSetup'>,
  processes: Processes | undefined,
  caller: OrgCaller,
  kind: OrgBundle['source']['kind'],
  access?: Rules,
): Result<{ bundle: OrgBundle; filename: string; left: string[] }> {
  const res = org.exportOrg(caller);
  if (!res.ok) return res;
  const defs = (processes?.list(caller) ?? []).filter((p) => !p.archived);
  const setupRes = org.exportSetup(caller);
  const setup: OrgBundleSetup = setupRes.ok ? setupRes.setup : {};
  const current = access?.rules(caller);
  if (current?.ok) {
    const all = current.rules as Record<string, unknown>;
    const rules = Object.fromEntries(PORTABLE_RULES.filter((k) => all[k] !== undefined && all[k] !== null).map((k) => [k, structuredClone(all[k])]));
    if (Object.keys(rules).length) setup.rules = rules;
  }
  const bundle: OrgBundle = { ...res.bundle, source: { ...res.bundle.source, kind }, processes: defs.map(bundleProcess), ...(Object.keys(setup).length ? { setup } : {}) };
  const left = [...res.left, 'Who the server is: its name, address, sign-in and admins stay as they are on the new server.'];
  if (setup.databases?.length || setup.apis?.length) left.push('Database and API passwords: each waits on Setup → Databases or APIs for an admin to type it.');
  return { ok: true, bundle, filename: orgBundleFilename(bundle.source.org, bundle.exportedAt), left };
}

/// The rules in an org file onto this server, through the rules page's own
/// checks. Only from the same org: another org's budgets and approvers
/// would name people who aren't here.
function importRules(access: Rules | undefined, caller: OrgCaller, rules: Record<string, unknown> | undefined, opts: { dryRun?: boolean; sameOrg: boolean }): OrgImportReport['setup'] {
  if (!rules || !Object.keys(rules).length) return [];
  if (!opts.sameOrg) return [{ kind: 'rules', name: 'Rules', status: 'skipped', note: 'They’re another org’s budgets, approvers and groups, so they’re left out.' }];
  const now = access?.rules(caller);
  if (!access || !now?.ok) return [{ kind: 'rules', name: 'Rules', status: 'skipped', note: 'This server’s rules can’t be changed from here.' }];
  const have = now.rules as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = Object.keys(rules).filter((k) => !same(rules[k], have[k]));
  if (!changed.length) return [{ kind: 'rules', name: 'Rules', status: 'alreadyHere' }];
  const names = changed.map((k) => RULE_LABEL[k] ?? k).join(', ');
  if (opts.dryRun) return [{ kind: 'rules', name: 'Rules', status: 'updated', note: names }];
  const patch = Object.fromEntries(changed.map((k) => [k, rules[k]]));
  const res = access.setRules(caller, patch);
  if (res.ok) return [{ kind: 'rules', name: 'Rules', status: 'updated', note: names }];
  // One bad rule shouldn't keep the rest out: each on its own.
  const rows: OrgImportReport['setup'] = [];
  const done: string[] = [];
  for (const k of changed) {
    const one = access.setRules(caller, { [k]: rules[k] });
    if (one.ok) done.push(RULE_LABEL[k] ?? k);
    else rows.push({ kind: 'rules', name: RULE_LABEL[k] ?? k, status: 'failed', note: one.error });
  }
  if (done.length) rows.unshift({ kind: 'rules', name: 'Rules', status: 'updated', note: done.join(', ') });
  return rows;
}

type Directory = Pick<OrgService, 'peopleDirectory'>;

/// The people in an org file, as people on this server. "You" on a desktop
/// is whoever moves the org. From the same org (trust kept), a Slack id this
/// server knows is that person, and one it doesn't is kept but listed for
/// the admin to check. From another org, a Slack id is another workspace's
/// and means nobody here: the person is found here by name when exactly one
/// person here goes by it, and otherwise is dropped, the admin standing in
/// and the process listed so someone reassigns it. Never a foreign id kept
/// to wait on an approval nobody here can give.
class People {
  private readonly byName = new Map<string, ProcessPerson | null>();
  private readonly ids = new Set<string>();
  readonly matched = new Set<string>();
  readonly unknown = new Set<string>();
  readonly missing = new Set<string>();

  constructor(
    dir: Directory | undefined,
    private readonly caller: OrgCaller,
    private readonly keeps: boolean,
  ) {
    for (const d of dir?.peopleDirectory() ?? []) {
      if (!d.slackUserId) continue;
      this.ids.add(d.slackUserId);
      for (const n of [d.name, ...(d.aliases ?? [])]) {
        const k = n.trim().toLowerCase();
        if (!k) continue;
        const prior = this.byName.get(k);
        // Two people by one name: neither is the one.
        this.byName.set(k, prior && prior.slackUserId !== d.slackUserId ? null : { name: d.name, slackUserId: d.slackUserId });
      }
    }
  }

  private admin(): ProcessPerson {
    return { name: this.caller.name, ...(this.caller.slackUserId ? { slackUserId: this.caller.slackUserId } : {}) };
  }

  /// Someone here for a person in the file, or null for nobody.
  find(p: ProcessPerson): ProcessPerson | null {
    if (!p.slackUserId && p.name.trim().toLowerCase() === 'you') return this.admin();
    if (this.keeps) {
      if (p.slackUserId && !this.ids.has(p.slackUserId)) this.unknown.add(p.name);
      return { ...p };
    }
    const here = this.byName.get(p.name.trim().toLowerCase());
    if (here) {
      this.matched.add(`${p.name} → ${here.name}`);
      return here;
    }
    this.missing.add(p.name);
    return null;
  }

  /// An owner: someone, the admin when nobody here is them.
  owner(p: ProcessPerson): ProcessPerson {
    return this.find(p) ?? this.admin();
  }

  /// Deciders: each found here, once; the admin when none is.
  deciders(list: ProcessPerson[]): ProcessPerson[] {
    const out: ProcessPerson[] = [];
    for (const a of list) {
      const p = this.find(a);
      if (p && !out.some((o) => (o.slackUserId ?? o.name) === (p.slackUserId ?? p.name))) out.push(p);
    }
    return out.length ? out : [this.admin()];
  }
}

/// Orgs with an import under way: one at a time each, held from before the
/// rules change until the last process lands.
const importing = new WeakSet<object>();

export async function importOrgBundle(
  org: Pick<OrgService, 'importOrg' | 'importSetup' | 'publishedTeamId' | 'publishedWorkerId'> & Partial<Directory>,
  processes: Processes | undefined,
  caller: OrgCaller,
  bundle: OrgBundle,
  opts: { dryRun?: boolean; start?: boolean; keepTrust?: boolean } = {},
  access?: Rules,
): Promise<Result<{ report: OrgImportReport }>> {
  if (bundle.processes.length && !processes) return { ok: false, error: 'Processes are not running on this server.' };
  if (opts.dryRun) return importOrgBundleNow(org, processes, caller, bundle, opts, access);
  if (importing.has(org)) return { ok: false, error: 'An org import is already running on this server. Wait for it to finish, then run this one again.' };
  importing.add(org);
  try {
    return await importOrgBundleNow(org, processes, caller, bundle, opts, access);
  } finally {
    importing.delete(org);
  }
}

async function importOrgBundleNow(
  org: Pick<OrgService, 'importOrg' | 'importSetup' | 'publishedTeamId' | 'publishedWorkerId'> & Partial<Directory>,
  processes: Processes | undefined,
  caller: OrgCaller,
  bundle: OrgBundle,
  opts: { dryRun?: boolean; start?: boolean; keepTrust?: boolean },
  access?: Rules,
): Promise<Result<{ report: OrgImportReport }>> {
  // Rules first: the workers that land next are hired under them (which
  // tools are cleared, who approves). The preview runs every check the real
  // import can fail on, so rules never change ahead of an import that fails.
  const preview = await org.importOrg(caller, { ...bundle, workers: [] }, { dryRun: true, keepTrust: opts.keepTrust });
  if (!preview.ok) return preview;
  const sameOrg = preview.report.keepsTrust;
  const ruleRows = importRules(access, caller, bundle.setup?.rules, { dryRun: opts.dryRun, sameOrg });
  const res = await org.importOrg(caller, bundle, opts);
  if (!res.ok) return res;
  const { report } = res;
  report.setup.push(...ruleRows);
  if (bundle.setup) {
    const from = bundle.source.org ?? (bundle.source.kind === 'desktop' ? 'an overcli app' : 'another server');
    const s = org.importSetup(caller, bundle.setup, { dryRun: opts.dryRun, sameOrg, from });
    if (s.ok) report.setup.push(...s.rows);
    else report.setup.push({ kind: 'rules', name: 'Setup', status: 'failed', note: s.error });
    if (report.setup.some((r) => r.status === 'waiting')) report.notes.push('Tools, repos, databases and APIs wait where each is set up, for an admin to add its keys or password. None came with the file.');
  }
  if (!processes) return res;
  const people = new People(org.peopleDirectory ? (org as Directory) : undefined, caller, report.keepsTrust);
  const reassign = new Set<string>();
  const known = new Map(processes.list(caller).filter((p) => p.localId).map((p) => [p.localId!, p]));
  // In a dry run nothing has landed: a team or worker counts as there if the
  // run says it would be.
  const plannedTeams = new Set(bundle.teams.filter((t, i) => report.teams[i]?.status !== 'failed').map((t) => t.sourceId));
  const plannedWorkers = new Set(report.workers.filter((w) => w.status !== 'failed').map((w) => w.sourceId));
  for (const p of bundle.processes) {
    const missing: string[] = [];
    const nobody = people.missing.size;
    const owner = p.owner ? people.owner(p.owner) : undefined;
    if (people.missing.size > nobody) reassign.add(p.name);
    const stages: ProcessStage[] = p.stages.map(({ sourceTeamId, sourceWorkerId, ...st }, i) => {
      const id = String(i + 1);
      const out = { ...st, id: st.id || id } as ProcessStage;
      const before = people.missing.size;
      if (st.owner) out.owner = people.owner(st.owner);
      if (!report.keepsTrust) {
        // Another org's groups are its ids; with whoever is left, one approval is enough.
        delete out.approverGroups;
        delete out.needs;
        if (st.approvers?.length || st.approverGroups?.length) out.approvers = people.deciders(st.approvers ?? []);
        if (st.approverGroups?.length) reassign.add(p.name);
      } else if (st.approvers) out.approvers = people.deciders(st.approvers);
      if (people.missing.size > before) reassign.add(p.name);
      if (st.kind === 'team') {
        const here = sourceTeamId ? org.publishedTeamId(sourceTeamId) : undefined;
        if (here) out.teamId = here;
        else if (opts.dryRun && sourceTeamId && plannedTeams.has(sourceTeamId)) out.teamId = sourceTeamId;
        else missing.push(st.name);
      } else if (st.kind === 'worker') {
        const here = sourceWorkerId ? org.publishedWorkerId(sourceWorkerId) : undefined;
        if (here) out.workerId = here;
        else if (opts.dryRun && sourceWorkerId && plannedWorkers.has(sourceWorkerId)) out.workerId = sourceWorkerId;
        else missing.push(st.name);
      }
      return out;
    });
    const exists = known.has(p.sourceId);
    if (missing.length) {
      reassign.delete(p.name);
      const list = missing.map((m) => `“${m}”`).join(', ');
      report.processes.push({ name: p.name, status: 'failed', error: `Left out: ${missing.length === 1 ? 'its stage' : 'its stages'} ${list} ${missing.length === 1 ? 'is' : 'are'} done by a team or worker that didn’t come over.` });
      continue;
    }
    if (opts.dryRun) {
      report.processes.push({ name: p.name, status: exists ? 'updated' : 'added' });
      continue;
    }
    const saved = processes.save(caller, {
      localId: p.sourceId,
      name: p.name,
      ...(p.purpose ? { purpose: p.purpose } : {}),
      ...(owner ? { owner } : {}),
      stages,
      ...(p.access !== undefined ? { access: p.access } : {}),
    });
    report.processes.push(saved.ok ? { name: p.name, status: saved.updated ? 'updated' : 'added' } : { name: p.name, status: 'failed', error: saved.error });
  }
  if (bundle.processes.length) {
    const names = (s: Set<string>) => [...s].join(', ');
    if (people.matched.size) report.notes.push(`Matched by name to people here: ${names(people.matched)}. Check each is the same person.`);
    if (reassign.size) report.notes.push(`${people.missing.size ? `Nobody here is ${names(people.missing)}` : 'Their deciding groups are another org’s'}, so you own or decide in their place on ${names(reassign)}. Set who decides on each process’s page.`);
    if (people.unknown.size) report.notes.push(`Not known on this server yet: ${names(people.unknown)}. Their stages wait on them; if any isn’t in this Slack workspace, reassign it on the process’s page.`);
  }
  return { ok: true, report };
}

/// An import's report as lines for a terminal or a chat.
export function describeImport(r: OrgImportReport): string[] {
  const lines: string[] = [r.dryRun ? 'Dry run: nothing was changed. This is what would land.' : 'Imported.', r.trustWhy, ''];
  const verb = (s: string) => (r.dryRun ? ({ added: 'would add', updated: 'would update', alreadyHere: 'already here', failed: 'can’t come' } as Record<string, string>)[s] : ({ added: 'added', updated: 'updated', alreadyHere: 'already here', failed: 'failed' } as Record<string, string>)[s]);
  lines.push(`Workers (${r.workers.length}):`);
  for (const w of r.workers) {
    lines.push(`  ${w.name}: ${verb(w.status)}${w.status === 'failed' ? ` — ${w.error}` : `, ${w.trust}, managed by ${w.manager}${w.paused ? ', paused' : ''}`}`);
    for (const n of w.notes) lines.push(`    · ${n}`);
  }
  if (r.teams.length) {
    lines.push('', `Teams (${r.teams.length}):`);
    for (const t of r.teams) lines.push(`  ${t.name}: ${verb(t.status)}${t.error ? ` — ${t.error}` : ''}`);
  }
  if (r.processes.length) {
    lines.push('', `Processes (${r.processes.length}):`);
    for (const p of r.processes) lines.push(`  ${p.name}: ${verb(p.status)}${p.error ? ` — ${p.error}` : ''}`);
  }
  if (r.setup.length) {
    const said: Record<string, string> = r.dryRun
      ? { added: 'would be added', updated: 'would be updated', alreadyHere: 'already here', waiting: 'would wait for its keys', skipped: 'left out', failed: 'can’t come' }
      : { added: 'added', updated: 'updated', alreadyHere: 'already here', waiting: 'waits for its keys', skipped: 'left out', failed: 'failed' };
    lines.push('', `Setup (${r.setup.length}):`);
    for (const s of r.setup) lines.push(`  ${s.kind} ${s.name}: ${said[s.status]}${s.where ? ` on ${s.where}` : ''}${s.note ? ` — ${s.note}` : ''}`);
  }
  if (r.needsKeys.length) {
    lines.push('', 'Tools that need their keys entered on this server:');
    for (const k of r.needsKeys) lines.push(`  ${k.tool} (used by ${k.workers.join(', ')})`);
  }
  if (r.notes.length) lines.push('', ...r.notes);
  return lines;
}
