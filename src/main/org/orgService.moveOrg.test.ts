import { describe, expect, it } from 'vitest';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import type { Team } from '../../shared/flows/team';
import { parseWorkerYaml, serializeWorker } from '../../shared/flows/workerYaml';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import type { ProcessDef } from '../../shared/org/process';
import { OrgService, type PendingHire } from './orgService';
import { parseOrgBundle, type OrgBundle } from './orgBundle';
import { describeImport, exportOrgBundle, importOrgBundle } from './orgMigrate';
import type { WorkerTrigger } from './triggers';

const ADMIN = 'U0ACMEADM';
const PAT = 'U0ACMEPAT';
const admin: OrgCaller = { slackUserId: ADMIN, name: 'Alex', admin: false };
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };

function worker(id: string, name: string, extra: Partial<Worker> = {}): Worker {
  return {
    id,
    name,
    jobDescription: `${name} reads the queue each morning and does its job.`,
    projectPath: '/data/Workers',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 2, runIn: 'worktree' } as Worker['caps'],
    budgetUSDPerMonth: 30,
    heartbeatModel: 'sonnet',
    flowIds: [],
    enabled: true,
    createdAt: 0,
    ...extra,
  };
}

const lead = worker('lead-1', 'Lead', { trust: 'autonomous', manager: { name: 'Pat', slackUserId: PAT }, mcpServers: ['tracker'], visibility: 'org' });
const triage = worker('triage-1', 'Triage', {
  trust: 'trusted',
  manager: { name: 'Pat', slackUserId: PAT },
  reportsTo: 'lead-1',
  mcpServers: ['tracker', 'repo-host'],
  knowledge: { status: 'ready', body: 'Tickets live on board 215.' },
});
const journal: WorkerJournalEntry[] = [
  { id: 'j1', workerId: 'triage-1', kind: 'completed', at: 2000, title: 'ACME-1 fix login' },
  { id: 'j2', workerId: 'triage-1', kind: 'note', at: 3000, title: '', note: 'Skip ACME-9' },
];

/// One org server: a roster, its teams, triggers and published ids, all in memory.
function server(opts: { policy?: Partial<OrgPolicy>; roster?: Worker[]; teams?: Team[]; installed?: string[]; extra?: Partial<ConstructorParameters<typeof OrgService>[0]> } = {}) {
  const roster = new Map<string, Worker>((opts.roster ?? []).map((w) => [w.id, structuredClone(w)]));
  let teams: Team[] = structuredClone(opts.teams ?? []);
  const triggers: WorkerTrigger[] = [];
  const remembered: string[] = [];
  let hires: PendingHire[] = [];
  let n = 0;
  const svc = new OrgService({
    workers: {
      roster: () => [...roster.values()],
      get: (id) => roster.get(id) ?? null,
      save: (w) => {
        roster.set(w.id, w);
        return { ok: true, worker: w };
      },
      setEnabled: (id, enabled) => {
        const w = roster.get(id);
        if (w) roster.set(id, { ...w, enabled });
        return { ok: true };
      },
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: (id) => (id === 'triage-1' ? journal : []),
      spentThisMonth: () => new Map(),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, admins: [ADMIN], hirers: '*', budgetAllowanceUSD: 10, allowedMcpServers: ['tracker'], ...opts.policy }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => hires, save: (h) => (hires = structuredClone(h)) },
    setTrust: (id, trust) => {
      const w = roster.get(id);
      if (!w) return { ok: false, error: 'gone' };
      roster.set(id, { ...w, trust });
      return { ok: true };
    },
    teams: {
      list: () => ({ teams, tasks: [] }),
      brief: () => ({ ok: false, error: 'no' }),
      save: (t: Omit<Team, 'id' | 'createdAt'> & { id?: string }) => {
        const team = { ...t, id: t.id ?? `team-${teams.length + 1}`, createdAt: 0 } as Team;
        teams = [...teams.filter((x) => x.id !== team.id), team];
        return { ok: true, team };
      },
    } as never,
    triggers: () =>
      ({
        list: (workerId?: string) => triggers.filter((t) => !workerId || t.workerId === workerId),
        create: (input: Omit<WorkerTrigger, 'id'>) => {
          const trigger = { ...input, id: `t${triggers.length + 1}` } as WorkerTrigger;
          triggers.push(trigger);
          return { ok: true, trigger, ...(input.kind === 'webhook' ? { token: 'tok' } : {}) };
        },
      }) as never,
    tools: {
      list: () => ({ tools: (opts.installed ?? []).map((name) => ({ name })) as never, missing: [] }),
      remember: (t) => remembered.push(...t.map((x) => x.name)),
      template: (name) => ({ name, kind: 'command', command: 'npx', args: ['-y', `${name}-mcp`], envKeys: ['API_TOKEN'], headerKeys: [] }),
      install: () => ({ ok: true }),
      uninstall: () => ({ ok: true }),
      check: async () => null,
    },
    shareWorker: (w, carried) => ({ yaml: serializeWorker({ worker: w, flows: [], carried }), filename: `${w.name}.worker.yaml`, missingFlowIds: [] }),
    importWorker: (yaml, o) => {
      const parsed = parseWorkerYaml(yaml);
      if (!parsed.ok) return parsed;
      const w = worker(`new-${++n}`, parsed.bundle.worker.name, { mcpServers: o.mcpServers, ...o.extra });
      roster.set(w.id, w);
      return { ok: true, worker: w };
    },
    audit: { append: () => {}, recent: () => [], all: () => [] },
    now: () => 1_700_000_000_000,
    ...opts.extra,
  });
  return { svc, roster, teams: () => teams, triggers, remembered };
}

const crew: Team = { id: 'team-a', name: 'Crew', members: [{ workerId: 'lead-1', role: 'Lead' }, { workerId: 'triage-1', role: 'Triage' }], budgetUSDPerTask: 5, checkpoints: {} as Team['checkpoints'], createdAt: 0 } as Team;

function exported(policy: Partial<OrgPolicy> = { slackTeamId: 'T0ACME001', name: 'Acme' }): OrgBundle {
  const from = server({ policy, roster: [lead, triage], teams: [crew] });
  const res = exportOrgBundle(from.svc, undefined, admin, 'server');
  if (!res.ok) throw new Error(res.error);
  // Through JSON and the parser, as a file would come.
  const parsed = parseOrgBundle(JSON.parse(JSON.stringify(res.bundle)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.bundle;
}

describe('exporting the whole org', () => {
  it('carries every worker with its trust, manager, reporting line, knowledge and journal, and its teams', () => {
    const b = exported();
    expect(b.source).toEqual({ kind: 'server', org: 'Acme', slackTeamId: 'T0ACME001' });
    const t = b.workers.find((w) => w.sourceId === 'triage-1')!;
    expect(t).toMatchObject({ trust: 'trusted', manager: { name: 'Pat', slackUserId: PAT }, reportsTo: 'lead-1' });
    const parsed = parseWorkerYaml(t.yaml);
    const c = parsed.ok ? parsed.bundle.carried : undefined;
    expect(c?.knowledge).toBe('Tickets live on board 215.');
    expect(c?.notes).toEqual([{ at: 3000, note: 'Skip ACME-9' }]);
    expect(c?.journal?.map((e) => e.title)).toEqual(['ACME-1 fix login']);
    expect(b.teams).toEqual([expect.objectContaining({ sourceId: 'team-a', members: [{ sourceId: 'lead-1', role: 'Lead' }, { sourceId: 'triage-1', role: 'Triage' }] })]);
  });

  it('holds no secret value: tools go as setting names only', () => {
    const b = exported();
    const text = JSON.stringify(b);
    expect(text).toContain('API_TOKEN');
    expect(text).not.toMatch(/"env"\s*:\s*\{/);
    expect(text).not.toMatch(/token"\s*:\s*"/i);
  });

  it('is for admins only', () => {
    const from = server({ roster: [lead] });
    expect(from.svc.exportOrg(pat)).toMatchObject({ ok: false });
  });
});

describe('importing an org file', () => {
  it('from the same Slack workspace keeps trust, managers and reporting lines, and lands workers paused', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' }, installed: ['tracker'] });
    const res = to.svc.importOrg(admin, exported());
    if (!res.ok) throw new Error(res.error);
    const r = res.report;
    expect(r.keepsTrust).toBe(true);
    const landed = [...to.roster.values()];
    const l = landed.find((w) => w.name === 'Lead')!;
    const t = landed.find((w) => w.name === 'Triage')!;
    expect(l.trust).toBe('autonomous');
    expect(l.caps.allowExternalActions).toBe(true);
    expect(l.visibility).toBe('org');
    expect(t.trust).toBe('trusted');
    expect(t.manager).toEqual({ name: 'Pat', slackUserId: PAT });
    expect(t.reportsTo).toBe(l.id);
    expect(landed.every((w) => !w.enabled)).toBe(true);
    // Kept even though this org hasn't cleared it: same org, an admin moving it.
    expect(t.mcpServers).toEqual(['tracker', 'repo-host']);
    expect(r.needsKeys).toEqual([{ tool: 'repo-host', workers: ['Triage'] }]);
    expect(to.remembered).toContain('repo-host');
    expect(to.teams().map((x) => ({ name: x.name, members: x.members.map((m) => m.workerId) }))).toEqual([{ name: 'Crew', members: [l.id, t.id] }]);
    expect(r.notes.join(' ')).toMatch(/land paused/);
  });

  it('with start, workers that ran there run here', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const res = to.svc.importOrg(admin, exported(), { start: true });
    expect(res.ok).toBe(true);
    expect([...to.roster.values()].every((w) => w.enabled)).toBe(true);
  });

  it('from another workspace lands each worker as a hire on probation, managed by the admin, with only cleared tools', () => {
    const to = server({ policy: { slackTeamId: 'T0OTHER01' } });
    const res = to.svc.importOrg(admin, exported());
    if (!res.ok) throw new Error(res.error);
    expect(res.report.keepsTrust).toBe(false);
    const t = [...to.roster.values()].find((w) => w.name === 'Triage')!;
    expect(t.trust).toBe('probation');
    expect(t.manager).toEqual({ name: 'Alex', slackUserId: ADMIN });
    expect(t.reportsTo).toBeUndefined();
    expect(t.mcpServers).toEqual(['tracker']);
  });

  it('from a file that names no workspace lands on probation unless the admin vouches for it', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const res = to.svc.importOrg(admin, exported({}));
    expect(res.ok && res.report.keepsTrust).toBe(false);
    expect([...to.roster.values()].every((w) => w.trust === 'probation' && w.manager?.slackUserId === ADMIN)).toBe(true);
    expect(res.ok && res.report.trustWhy).toMatch(/--keep-trust/);
  });

  it('vouching can’t carry trust across from another workspace', () => {
    const to = server({ policy: { slackTeamId: 'T0OTHER01' } });
    const res = to.svc.importOrg(admin, exported(), { keepTrust: true });
    expect(res.ok && res.report.keepsTrust).toBe(false);
  });

  it('from a personal install keeps trust when the admin vouches for it', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const res = to.svc.importOrg(admin, exported({}), { keepTrust: true });
    expect(res.ok && res.report.keepsTrust).toBe(true);
    // Its manager had a Slack id, so it is still them.
    expect([...to.roster.values()].find((w) => w.name === 'Triage')?.manager?.slackUserId).toBe(PAT);
  });

  it('a dry run changes nothing and says what would land', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const res = to.svc.importOrg(admin, exported(), { dryRun: true });
    if (!res.ok) throw new Error(res.error);
    expect(to.roster.size).toBe(0);
    expect(to.teams()).toEqual([]);
    expect(res.report.workers.map((w) => [w.name, w.status, w.trust])).toEqual([
      ['Lead', 'added', 'autonomous'],
      ['Triage', 'added', 'trusted'],
    ]);
    expect(res.report.teams).toEqual([{ name: 'Crew', status: 'added' }]);
  });

  it('is safe to run again: what already came is left alone', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const b = exported();
    expect(to.svc.importOrg(admin, b).ok).toBe(true);
    const again = to.svc.importOrg(admin, b);
    if (!again.ok) throw new Error(again.error);
    expect(to.roster.size).toBe(2);
    expect(again.report.workers.map((w) => w.status)).toEqual(['alreadyHere', 'alreadyHere']);
    expect(again.report.teams).toEqual([{ name: 'Crew', status: 'updated' }]);
    expect(to.teams()).toHaveLength(1);
  });

  it('run again after a partial run, sets the reporting line the first run couldn’t', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const b = exported();
    // The first run: only Triage came, so its manager worker didn't.
    const first = to.svc.importOrg(admin, { ...b, workers: b.workers.filter((w) => w.sourceId === 'triage-1'), teams: [] });
    if (!first.ok) throw new Error(first.error);
    const t = () => [...to.roster.values()].find((w) => w.name === 'Triage')!;
    expect(t().reportsTo).toBeUndefined();
    const again = to.svc.importOrg(admin, b);
    if (!again.ok) throw new Error(again.error);
    const l = [...to.roster.values()].find((w) => w.name === 'Lead')!;
    expect(t().reportsTo).toBe(l.id);
    expect(again.report.workers.find((w) => w.name === 'Triage')?.notes.join(' ')).toMatch(/reporting line is set now/);
  });

  it('run again, leaves a reporting line already set by hand alone', () => {
    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const b = exported();
    expect(to.svc.importOrg(admin, b).ok).toBe(true);
    const t = [...to.roster.values()].find((w) => w.name === 'Triage')!;
    to.roster.set(t.id, { ...t, reportsTo: 'someone-else' });
    expect(to.svc.importOrg(admin, b).ok).toBe(true);
    expect(to.roster.get(t.id)?.reportsTo).toBe('someone-else');
  });

  it('is for admins only', () => {
    const to = server();
    expect(to.svc.importOrg(pat, exported())).toMatchObject({ ok: false, error: expect.stringMatching(/admin/) });
  });
});

describe('processes in an org file', () => {
  const def: ProcessDef = {
    id: 'proc-1',
    name: 'Ship it',
    owner: { name: 'You' },
    stages: [
      { id: 's1', name: 'Build', kind: 'team', teamId: 'team-a' },
      { id: 's2', name: 'Sign off', kind: 'people', approvers: [{ name: 'You' }, { name: 'Pat', slackUserId: PAT }] },
    ],
    createdBy: 'You',
    createdAt: 0,
    updatedAt: 0,
  };

  function processes(defs: ProcessDef[] = []) {
    const saved: Array<Record<string, unknown>> = [];
    return {
      saved,
      svc: {
        list: () => defs as never,
        save: (_c: OrgCaller, input: Record<string, unknown>) => {
          saved.push(input);
          return { ok: true as const, process: input as never, updated: false };
        },
      },
    };
  }

  it('travel with their team stages mapped to the copy that landed, and "You" becomes the admin', () => {
    const from = server({ policy: { slackTeamId: 'T0ACME001' }, roster: [lead, triage], teams: [crew] });
    const out = exportOrgBundle(from.svc, processes([def]).svc, admin, 'desktop');
    if (!out.ok) throw new Error(out.error);
    expect(out.bundle.processes[0].stages[0]).toMatchObject({ kind: 'team', sourceTeamId: 'team-a' });
    const parsed = parseOrgBundle(JSON.parse(JSON.stringify(out.bundle)));
    if (!parsed.ok) throw new Error(parsed.error);

    const to = server({ policy: { slackTeamId: 'T0ACME001' } });
    const p = processes();
    const res = importOrgBundle(to.svc, p.svc, admin, parsed.bundle);
    if (!res.ok) throw new Error(res.error);
    expect(res.report.processes).toEqual([{ name: 'Ship it', status: 'added' }]);
    const stages = p.saved[0].stages as Array<Record<string, unknown>>;
    expect(stages[0].teamId).toBe(to.teams()[0].id);
    expect(stages[1].approvers).toEqual([{ name: 'Alex', slackUserId: ADMIN }, { name: 'Pat', slackUserId: PAT }]);
    expect(p.saved[0].owner).toEqual({ name: 'Alex', slackUserId: ADMIN });
  });

  it('from another workspace, every owner and decider is the admin and its groups are dropped', () => {
    const from = server({ policy: { slackTeamId: 'T0ACME001' }, roster: [lead, triage], teams: [crew] });
    const withGroups: ProcessDef = { ...def, stages: [def.stages[0], { ...def.stages[1], approverGroups: [{ id: 'team:Leads', name: 'Leads' }], needs: 'all' }] };
    const out = exportOrgBundle(from.svc, processes([withGroups]).svc, admin, 'server');
    if (!out.ok) throw new Error(out.error);
    const to = server({ policy: { slackTeamId: 'T0OTHER01' } });
    const p = processes();
    const res = importOrgBundle(to.svc, p.svc, admin, out.bundle);
    if (!res.ok) throw new Error(res.error);
    const stage = (p.saved[0].stages as Array<Record<string, unknown>>)[1];
    expect(stage.approvers).toEqual([{ name: 'Alex', slackUserId: ADMIN }]);
    expect(stage.approverGroups).toBeUndefined();
    expect(stage.needs).toBeUndefined();
    expect(p.saved[0].owner).toEqual({ name: 'Alex', slackUserId: ADMIN });
    expect(res.report.notes.join(' ')).toMatch(/you own and decide every stage/);
  });

  it('a process whose team didn’t come is reported, not saved', () => {
    const b = exported();
    b.teams = [];
    b.processes = [{ sourceId: 'proc-1', name: 'Ship it', stages: [{ id: 's1', name: 'Build', kind: 'team', sourceTeamId: 'team-a' }] }];
    const p = processes();
    const res = importOrgBundle(server({ policy: { slackTeamId: 'T0ACME001' } }).svc, p.svc, admin, b);
    expect(res.ok && res.report.processes).toEqual([{ name: 'Ship it', status: 'failed', error: 'The team or worker for Build didn’t come.' }]);
    expect(p.saved).toEqual([]);
  });
});

describe('reading an org file', () => {
  it('refuses something that is not one', () => {
    expect(parseOrgBundle({ workers: [] }).ok).toBe(false);
    expect(parseOrgBundle({ format: 'overgo-org', version: 99 })).toMatchObject({ ok: false, error: expect.stringMatching(/version 99/) });
  });

  it('drops a reporting line to a worker that isn’t in it, and an unknown trust level', () => {
    const res = parseOrgBundle({
      format: 'overgo-org',
      version: 1,
      source: { kind: 'server' },
      workers: [{ sourceId: 'a', yaml: 'x: 1', trust: 'godmode', reportsTo: 'nobody' }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.bundle.workers[0].trust).toBe('probation');
    expect(res.bundle.workers[0].reportsTo).toBeUndefined();
  });

  it('refuses two workers with the same id', () => {
    const w = { sourceId: 'a', yaml: 'x: 1', trust: 'probation' };
    expect(parseOrgBundle({ format: 'overgo-org', version: 1, workers: [w, w] }).ok).toBe(false);
  });
});

describe('the org’s setup in an org file', () => {
  const db = { id: 'db-1', name: 'Orders', env: 'prod', engine: 'postgres', host: 'db.acme.internal', port: 5432, database: 'orders', user: 'reader', credential: { source: 'secret', env: 'ORDERS_DB_PASSWORD' } };

  /// A server with a handbook, tools, repos, a workspace and a database, and
  /// a rules page that keeps what it's given.
  function setUp(policy: Partial<OrgPolicy>, have: { handbook?: string; installed?: string[]; repos?: string[]; dbs?: unknown[] } = {}) {
    let handbook = have.handbook ?? '';
    let offers: unknown[] = [];
    let dbOffers: unknown[] = [];
    let rules: Record<string, unknown> = { hirers: [], budgetAllowanceUSD: 50, orgBudgetUSD: null, approvers: [] };
    const access = {
      rules: () => ({ ok: true as const, rules }),
      setRules: (_c: OrgCaller, patch: Record<string, unknown>) => {
        if (patch.budgetAllowanceUSD === -1) return { ok: false as const, error: 'budgetAllowanceUSD must be at least 0.' };
        rules = { ...rules, ...patch };
        return { ok: true as const };
      },
    };
    const s = server({
      policy,
      installed: have.installed,
      extra: {
        handbook: { read: () => handbook, write: (t: string) => (handbook = t) },
        repos: {
          list: () => (have.repos ?? []).map((name) => ({ name, url: `https://pat:hunter2@git.acme.example/acme/${name}.git`, path: `/data/repos/${name}`, defaultBranch: 'main' })),
          workspaces: () => (have.repos?.length ? [{ id: 'ws-shop', name: 'Shop', repos: have.repos, instructions: 'Web calls the API.' }] : []),
        } as never,
        setupOffers: { load: () => ({ offers }), save: (v: { offers: unknown[] }) => (offers = v.offers) } as never,
        overdbOffers: { load: () => ({ offers: dbOffers as never }), save: (v: { offers: unknown[] }) => (dbOffers = v.offers) },
        overdbConnections: { load: () => ({ version: 1, connections: (have.dbs ?? []) as never }), save: () => {} },
        overdb: { headlessPath: () => null, connectionsFile: () => '', toolEnv: () => ({ ORDERS_DB_PASSWORD: 's3cret-pw' }), queryLogFile: () => '', readQueryLog: () => '' },
      },
    });
    return { ...s, access, rules: () => rules, handbook: () => handbook, offers: () => offers, dbOffers: () => dbOffers };
  }

  function bundleFrom(): OrgBundle {
    const from = setUp({ slackTeamId: 'T0ACME001', name: 'Acme' }, { handbook: 'Tickets live on board 215.', installed: ['tracker', 'overdb'], repos: ['web', 'api'], dbs: [db] });
    from.access.setRules(admin, { budgetAllowanceUSD: 200, orgBudgetUSD: 3000, approvers: [PAT] });
    const res = exportOrgBundle(from.svc, undefined, admin, 'server', from.access);
    if (!res.ok) throw new Error(res.error);
    const parsed = parseOrgBundle(JSON.parse(JSON.stringify(res.bundle)));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.bundle;
  }

  it('carries rules, handbook, tools, repos, workspaces and databases, with no secret value anywhere', () => {
    const b = bundleFrom();
    const text = JSON.stringify(b);
    expect(b.setup?.rules).toMatchObject({ budgetAllowanceUSD: 200, orgBudgetUSD: 3000, approvers: [PAT] });
    expect(b.setup?.handbook).toBe('Tickets live on board 215.');
    // overdb is set up from its databases, not as a tool.
    expect(b.setup?.tools?.map((t) => t.name)).toEqual(['tracker']);
    expect(b.setup?.repos).toEqual([
      { name: 'web', url: 'https://git.acme.example/acme/web.git' },
      { name: 'api', url: 'https://git.acme.example/acme/api.git' },
    ]);
    expect(b.setup?.workspaces).toEqual([{ name: 'Shop', repos: ['web', 'api'], instructions: 'Web calls the API.' }]);
    expect(b.setup?.databases).toEqual([expect.objectContaining({ id: 'db-1', credential: { source: 'secret', env: 'ORDERS_DB_PASSWORD' } })]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('s3cret-pw');
    expect(text).not.toContain('hasPassword');
  });

  it('into the same org: rules and handbook land, the rest waits for its keys where each is set up', () => {
    const to = setUp({ slackTeamId: 'T0ACME001' });
    const res = importOrgBundle(to.svc, undefined, admin, bundleFrom(), {}, to.access);
    if (!res.ok) throw new Error(res.error);
    const rows = res.report.setup;
    expect(to.rules()).toMatchObject({ budgetAllowanceUSD: 200, orgBudgetUSD: 3000, approvers: [PAT] });
    expect(to.handbook()).toBe('Tickets live on board 215.');
    expect(rows.find((r) => r.kind === 'tool')).toMatchObject({ name: 'tracker', status: 'waiting', where: 'Setup → From desktops', note: 'Needs API_TOKEN.' });
    expect(rows.filter((r) => r.kind === 'repo').map((r) => r.status)).toEqual(['waiting', 'waiting']);
    expect(rows.find((r) => r.kind === 'database')).toMatchObject({ name: 'Orders (prod)', status: 'waiting', where: 'Setup → Databases' });
    expect(to.offers()).toEqual([expect.objectContaining({ by: 'Moved from Acme', tools: [expect.objectContaining({ name: 'tracker' })], repos: expect.any(Array), workspaces: expect.any(Array) })]);
    expect(to.dbOffers()).toHaveLength(1);
    expect(describeImport(res.report).join('\n')).toMatch(/tool tracker: waits for its keys on Setup → From desktops/);
  });

  it('importing again replaces what the last import left waiting, and leaves what is here alone', () => {
    const to = setUp({ slackTeamId: 'T0ACME001' }, { installed: ['tracker'] });
    const b = bundleFrom();
    importOrgBundle(to.svc, undefined, admin, b, {}, to.access);
    const again = importOrgBundle(to.svc, undefined, admin, b, {}, to.access);
    if (!again.ok) throw new Error(again.error);
    expect(to.offers()).toHaveLength(1);
    expect(again.report.setup.find((r) => r.kind === 'tool')?.status).toBe('alreadyHere');
    expect(again.report.setup.find((r) => r.kind === 'rules')?.status).toBe('alreadyHere');
  });

  it('a dry run says what would change and changes nothing', () => {
    const to = setUp({ slackTeamId: 'T0ACME001' });
    const res = importOrgBundle(to.svc, undefined, admin, bundleFrom(), { dryRun: true }, to.access);
    if (!res.ok) throw new Error(res.error);
    expect(res.report.setup.find((r) => r.kind === 'rules')).toMatchObject({ status: 'updated', note: expect.stringMatching(/Hiring allowance.*Monthly org budget/) });
    expect(to.rules().budgetAllowanceUSD).toBe(50);
    expect(to.handbook()).toBe('');
    expect(to.offers()).toEqual([]);
    expect(to.dbOffers()).toEqual([]);
  });

  it('from another org leaves its rules and handbook out', () => {
    const to = setUp({ slackTeamId: 'T0OTHER01' });
    const res = importOrgBundle(to.svc, undefined, admin, bundleFrom(), {}, to.access);
    if (!res.ok) throw new Error(res.error);
    expect(to.rules().budgetAllowanceUSD).toBe(50);
    expect(to.handbook()).toBe('');
    expect(res.report.setup.filter((r) => r.kind === 'rules' || r.kind === 'handbook').map((r) => r.status)).toEqual(['skipped', 'skipped']);
  });

  it('keeps a handbook this server already has', () => {
    const to = setUp({ slackTeamId: 'T0ACME001' }, { handbook: 'Our own.' });
    const res = importOrgBundle(to.svc, undefined, admin, bundleFrom(), {}, to.access);
    expect(to.handbook()).toBe('Our own.');
    expect(res.ok && res.report.setup.find((r) => r.kind === 'handbook')?.status).toBe('skipped');
  });

  it('one rule the server refuses doesn’t keep the others out', () => {
    const to = setUp({ slackTeamId: 'T0ACME001' });
    const b = bundleFrom();
    b.setup!.rules = { ...b.setup!.rules, budgetAllowanceUSD: -1 };
    const res = importOrgBundle(to.svc, undefined, admin, b, {}, to.access);
    if (!res.ok) throw new Error(res.error);
    expect(to.rules()).toMatchObject({ orgBudgetUSD: 3000, budgetAllowanceUSD: 50 });
    expect(res.report.setup.filter((r) => r.kind === 'rules').map((r) => r.status)).toEqual(['updated', 'failed']);
  });
});

describe('a worker’s whole history in an org file', () => {
  // 1,500 turns, a turned-down idea among the oldest, and 80 notes: more than
  // one worker's share carries, less than the server keeps.
  const long: WorkerJournalEntry[] = [
    { id: 'r0', workerId: 'triage-1', kind: 'rejected', at: 1, title: 'Rewrite the billing module' },
    ...Array.from({ length: 1500 }, (_, i): WorkerJournalEntry => ({ id: `c${i}`, workerId: 'triage-1', kind: 'completed', at: 10 + i, title: `ACME-${i} fixed` })),
    ...Array.from({ length: 80 }, (_, i): WorkerJournalEntry => ({ id: `n${i}`, workerId: 'triage-1', kind: 'note', at: 5000 + i, title: '', note: `Note ${i}` })),
  ];
  const from = () => server({ policy: { slackTeamId: 'T0ACME001' }, roster: [triage], extra: {} });

  function carriedOf(yaml: string) {
    const p = parseWorkerYaml(yaml);
    if (!p.ok) throw new Error(p.error);
    return p.bundle.carried!;
  }

  it('moving the org carries all of it, oldest rejection included, and it reads back whole', () => {
    const s = from();
    (s.svc as unknown as { deps: { workers: { journalFor: (id: string) => WorkerJournalEntry[] } } }).deps.workers.journalFor = () => long;
    const res = s.svc.exportOrg(admin);
    if (!res.ok) throw new Error(res.error);
    const c = carriedOf(res.bundle.workers[0].yaml);
    expect(c.journal).toHaveLength(1501);
    expect(c.journal?.[0]).toMatchObject({ kind: 'rejected', title: 'Rewrite the billing module' });
    expect(c.notes).toHaveLength(80);
    expect(res.left.join(' ')).not.toMatch(/oldest/);
  });

  it('exporting one worker for another org still trims it', () => {
    const s = from();
    (s.svc as unknown as { deps: { workers: { journalFor: (id: string) => WorkerJournalEntry[] } } }).deps.workers.journalFor = () => long;
    const res = s.svc.exportWorker(admin, 'Triage', { learned: true, journal: true });
    if (!res.ok) throw new Error(res.error);
    const c = carriedOf(res.yaml);
    expect(c.journal).toHaveLength(1000);
    expect(c.notes).toHaveLength(50);
    expect(res.left.join(' ')).toMatch(/oldest 501 journal entries/);
    expect(res.left.join(' ')).toMatch(/oldest 30 notes/);
  });
});
