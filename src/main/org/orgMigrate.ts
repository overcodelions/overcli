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

/// "You" on a desktop is whoever moves the org. From another org nobody in
/// the file is anyone here (their Slack ids are another workspace's), so
/// every person becomes the admin moving it.
function person(p: ProcessPerson, caller: OrgCaller, keeps: boolean): ProcessPerson {
  const you = !p.slackUserId && p.name.trim().toLowerCase() === 'you';
  if (you || !keeps) return { name: caller.name, ...(caller.slackUserId ? { slackUserId: caller.slackUserId } : {}) };
  return { ...p };
}

/// A stage's deciders from another org: just the admin, its groups (another
/// org's ids) dropped, and one approval enough, since one person is left.
function foreignDeciders(st: ProcessStage, caller: OrgCaller): Pick<ProcessStage, 'approvers' | 'approverGroups' | 'needs'> {
  const out: Pick<ProcessStage, 'approvers' | 'approverGroups' | 'needs'> = {};
  if (st.approvers?.length || st.approverGroups?.length) out.approvers = [person({ name: 'You' }, caller, false)];
  return out;
}

export function importOrgBundle(
  org: Pick<OrgService, 'importOrg' | 'importSetup' | 'publishedTeamId' | 'publishedWorkerId'>,
  processes: Processes | undefined,
  caller: OrgCaller,
  bundle: OrgBundle,
  opts: { dryRun?: boolean; start?: boolean; keepTrust?: boolean } = {},
  access?: Rules,
): Result<{ report: OrgImportReport }> {
  if (bundle.processes.length && !processes) return { ok: false, error: 'Processes are not running on this server.' };
  // Rules first: the workers that land next are hired under them (which
  // tools are cleared, who approves). The preview runs every check the real
  // import can fail on, so rules never change ahead of an import that fails.
  const preview = org.importOrg(caller, { ...bundle, workers: [] }, { dryRun: true, keepTrust: opts.keepTrust });
  if (!preview.ok) return preview;
  const sameOrg = preview.report.keepsTrust;
  const ruleRows = importRules(access, caller, bundle.setup?.rules, { dryRun: opts.dryRun, sameOrg });
  const res = org.importOrg(caller, bundle, opts);
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
  if (!report.keepsTrust && bundle.processes.length) report.notes.push('Its processes name people in another org, so you own and decide every stage for now. Set who decides on each process’s page.');
  const known = new Map(processes.list(caller).filter((p) => p.localId).map((p) => [p.localId!, p]));
  // In a dry run nothing has landed: a team or worker counts as there if the
  // run says it would be.
  const plannedTeams = new Set(bundle.teams.filter((t, i) => report.teams[i]?.status !== 'failed').map((t) => t.sourceId));
  const plannedWorkers = new Set(report.workers.filter((w) => w.status !== 'failed').map((w) => w.sourceId));
  for (const p of bundle.processes) {
    const missing: string[] = [];
    const stages: ProcessStage[] = p.stages.map(({ sourceTeamId, sourceWorkerId, ...st }, i) => {
      const id = String(i + 1);
      const out = { ...st, id: st.id || id } as ProcessStage;
      if (st.owner) out.owner = person(st.owner, caller, report.keepsTrust);
      if (!report.keepsTrust) {
        delete out.approverGroups;
        delete out.needs;
        Object.assign(out, foreignDeciders(st, caller));
      } else if (st.approvers) out.approvers = st.approvers.map((a) => person(a, caller, true));
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
      report.processes.push({ name: p.name, status: 'failed', error: `The team or worker for ${missing.join(', ')} didn’t come.` });
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
      ...(p.owner ? { owner: person(p.owner, caller, report.keepsTrust) } : {}),
      stages,
      ...(p.access !== undefined ? { access: p.access } : {}),
    });
    report.processes.push(saved.ok ? { name: p.name, status: saved.updated ? 'updated' : 'added' } : { name: p.name, status: 'failed', error: saved.error });
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
