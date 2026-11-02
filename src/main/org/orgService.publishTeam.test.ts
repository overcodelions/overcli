import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import type { Team } from '../../shared/flows/team';
import { DEFAULT_TEAM_CHECKPOINTS } from '../../shared/flows/team';
import { parseWorkerYaml, serializeWorker } from '../../shared/flows/workerYaml';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, type PendingHire, type TeamPublishInput } from './orgService';
import type { AuditEntry, PublishedState } from './orgStores';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const BOSS = 'U0ACMEBOSS';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const boss: OrgCaller = { slackUserId: BOSS, name: 'Bo', admin: false };

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches competitor sites and reports changes each week.',
    projectPath: '/repo',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

function harness(policy: Partial<OrgPolicy> = {}) {
  const roster = new Map<string, Worker>();
  const teams = new Map<string, Team>();
  let hires: PendingHire[] = [];
  let published: PublishedState = { workers: {}, teams: {}, waiting: [] };
  const audit: AuditEntry[] = [];
  const rosterAsks: string[][] = [];
  let n = 0;
  const svc = new OrgService({
    workers: {
      roster: () => [...roster.values()],
      get: (id) => roster.get(id) ?? null,
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*', ...policy }),
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => hires, save: (h) => (hires = structuredClone(h)) },
    teams: {
      list: () => ({ teams: [...teams.values()], tasks: [] }),
      brief: () => ({ ok: false, error: 'no' }),
      answer: () => ({ ok: true }),
      approve: () => ({ ok: true }),
      revise: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
      save: (input) => {
        const team: Team = { ...input, id: input.id ?? `srv-team-${teams.size + 1}`, createdAt: 0 };
        teams.set(team.id, team);
        return { ok: true, team };
      },
      draftRoster: async (args) => {
        rosterAsks.push(args.onlyWorkerIds);
        return {
          ok: true,
          draft: {
            name: 'Pair',
            purpose: 'Writes PR/FAQs',
            note: 'Two writers.',
            members: [...args.onlyWorkerIds.map((workerId) => ({ kind: 'worker' as const, workerId, role: 'Writes' })), { kind: 'hire' as const, job: 'A designer', role: 'Designs the visuals' }],
          },
        };
      },
    },
    published: { load: () => structuredClone(published), save: (s) => (published = structuredClone(s)) },
    importWorker: (yaml, o) => {
      const parsed = parseWorkerYaml(yaml);
      if (!parsed.ok) return parsed;
      const w = worker(`srv-${++n}`, { name: parsed.bundle.worker.name, manager: o.extra.manager });
      roster.set(w.id, w);
      return { ok: true, worker: w };
    },
    audit: { append: (e) => audit.push(e), recent: (k) => audit.slice(-k).reverse(), all: () => [...audit] },
    now: () => 0,
  });
  return { svc, roster, teams, audit, rosterAsks, hires: () => hires };
}

const member = (localId: string, name: string, budget = 20) => ({
  localId,
  role: `${name} on the team`,
  yaml: serializeWorker({ worker: worker(localId, { name, budgetUSDPerMonth: budget }), flows: [] }),
});

const launch = (over: Partial<TeamPublishInput> = {}): TeamPublishInput => ({
  localId: 'local-team',
  name: 'Launch crew',
  purpose: 'Ship the launch post',
  budgetUSDPerTask: 40,
  checkpoints: { finalReview: false },
  members: [member('local-ada', 'Ada'), member('local-cy', 'Cy')],
  ...over,
});

describe('publishing a team', () => {
  it('publishes its members, then the team, and updates it in place the second time', () => {
    const h = harness({ budgetAllowanceUSD: 100 });
    const first = h.svc.publishTeam(pat, launch());
    expect(first).toMatchObject({ ok: true, updated: false, added: ['Ada', 'Cy'], reused: [], waitingOn: [], team: { name: 'Launch crew' } });
    const team = [...h.teams.values()][0];
    expect(team.members.map((m) => h.roster.get(m.workerId)?.name)).toEqual(['Ada', 'Cy']);
    expect(team.checkpoints).toEqual({ ...DEFAULT_TEAM_CHECKPOINTS, finalReview: false });
    expect(team.projectPath).toBeUndefined();
    expect(h.roster.get(team.members[0].workerId)?.manager?.slackUserId).toBe(PAT);

    const again = h.svc.publishTeam(pat, launch({ name: 'Launch squad', members: [member('local-ada', 'Ada'), member('local-cy', 'Cy'), member('local-di', 'Di')] }));
    expect(again).toMatchObject({ ok: true, updated: true, added: ['Di'], reused: ['Ada', 'Cy'] });
    expect(h.teams.size).toBe(1);
    expect(h.roster.size).toBe(3);
    expect([...h.teams.values()][0]).toMatchObject({ id: team.id, name: 'Launch squad' });
  });

  it('holds the team until a member over the allowance is approved', () => {
    const h = harness({ budgetAllowanceUSD: 30, approvers: [BOSS] });
    const res = h.svc.publishTeam(pat, launch({ members: [member('local-ada', 'Ada'), member('local-cy', 'Cy', 25)] }));
    expect(res).toMatchObject({ ok: true, added: ['Ada'], waitingOn: ['Cy'] });
    expect(h.teams.size).toBe(0);
    const hire = h.hires().find((x) => x.status === 'awaitingApproval')!;
    expect(h.svc.decideHire(boss, hire.id, true).ok).toBe(true);
    expect([...h.teams.values()].map((t) => t.name)).toEqual(['Launch crew']);
    expect(h.audit.at(-1)?.what).toContain('its last member was approved');
  });

  it('drops the waiting team when a member is turned down', () => {
    const h = harness({ budgetAllowanceUSD: 30, approvers: [BOSS] });
    h.svc.publishTeam(pat, launch({ members: [member('local-ada', 'Ada'), member('local-cy', 'Cy', 25)] }));
    const hire = h.hires().find((x) => x.status === 'awaitingApproval')!;
    h.svc.decideHire(boss, hire.id, false);
    expect(h.teams.size).toBe(0);
    expect(h.audit.at(-1)?.what).toBe('The team Launch crew was not made: Cy was turned down.');
  });

  it('refuses a short team, a caller who may not hire, and someone else changing it', () => {
    const h = harness({ budgetAllowanceUSD: 100 });
    expect(h.svc.publishTeam(pat, launch({ members: [member('local-ada', 'Ada')] })).ok).toBe(false);
    expect(harness({ hirers: [] }).svc.publishTeam(pat, launch()).ok).toBe(false);
    h.svc.publishTeam(pat, launch());
    expect(h.svc.publishTeam(sam, launch())).toMatchObject({ ok: false, error: expect.stringContaining('already on the org') });
  });
});

describe('making a team on the server', () => {
  it('takes only workers the caller manages', () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('c', worker('c', { manager: { name: 'Sam', slackUserId: SAM } }));
    const members = (ids: string[]) => ids.map((workerId) => ({ workerId, role: 'Writes' }));
    expect(h.svc.makeTeam(pat, { name: 'Pair', budgetUSDPerTask: 30, members: members(['a', 'c']) })).toMatchObject({ ok: false, error: expect.stringContaining("don't manage C") });
    expect(h.svc.makeTeam(pat, { name: 'Pair', budgetUSDPerTask: 30, members: members(['a', 'b']) })).toMatchObject({ ok: true, team: { name: 'Pair' } });
  });

  it('keeps the check-ins it was made with', () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    const made = h.svc.makeTeam(pat, { name: 'Pair', budgetUSDPerTask: 30, members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }], checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS, reviewBeforeChallenge: true } });
    if (!made.ok) throw new Error(made.error);
    expect(h.teams.get(made.team.id)!.checkpoints.reviewBeforeChallenge).toBe(true);
  });

  it('lets a manager on the team change its check-ins and whether pieces ask first', () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    const made = h.svc.makeTeam(pat, { name: 'Pair', budgetUSDPerTask: 30, members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }] });
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.updateTeamSettings(pat, made.team.id, { piecesAskFirst: false, checkpoints: { finalReview: false } })).toEqual({ ok: true });
    const team = h.teams.get(made.team.id)!;
    expect(team.piecesAskFirst).toBe(false);
    expect(team.checkpoints).toMatchObject({ finalReview: false, askFirst: true });
    expect(h.svc.updateTeamSettings(sam, made.team.id, { piecesAskFirst: true })).toMatchObject({ ok: false });
    expect(h.svc.updateTeamSettings(pat, made.team.id, { piecesAskFirst: true })).toEqual({ ok: true });
    expect(h.teams.get(made.team.id)!.piecesAskFirst).toBeUndefined();
  });

  it('lets a manager change what a team is and who is on it', () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('c', worker('c', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('d', worker('d', { manager: { name: 'Sam', slackUserId: SAM } }));
    const made = h.svc.makeTeam(pat, { name: 'Pair', purpose: 'Writes launch notes.', budgetUSDPerTask: 30, members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }] });
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.editTeam(pat, made.team.id, { name: 'Launch crew', purpose: 'Writes and checks every launch FAQ.' })).toEqual({ ok: true });
    expect(h.teams.get(made.team.id)).toMatchObject({ name: 'Launch crew', purpose: 'Writes and checks every launch FAQ.' });
    // Swap a member for one Pat manages; roles come along.
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Leads' }, { workerId: 'c', role: 'Checks' }] })).toEqual({ ok: true });
    expect(h.teams.get(made.team.id)!.members).toEqual([{ workerId: 'a', role: 'Leads' }, { workerId: 'c', role: 'Checks' }]);
    // Not a worker Pat manages, a missing role, or fewer than two: refused.
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Leads' }, { workerId: 'd', role: 'Checks' }] })).toMatchObject({ ok: false, error: expect.stringContaining("don't manage D") });
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Leads' }, { workerId: 'c', role: ' ' }] })).toMatchObject({ ok: false });
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Leads' }] })).toMatchObject({ ok: false, error: expect.stringContaining('at least two') });
    expect(h.svc.editTeam(pat, made.team.id, { name: '  ' })).toMatchObject({ ok: false });
    // Someone who manages no one on it can't change it.
    expect(h.svc.editTeam(sam, made.team.id, { purpose: 'Something else.' })).toMatchObject({ ok: false });
    expect(h.teams.get(made.team.id)!.purpose).toBe('Writes and checks every launch FAQ.');
  });

  it('lets a manager take off only their own workers, and move only a team they manage whole', () => {
    const h = harness();
    const ada: OrgCaller = { slackUserId: 'U0ACMEADA', name: 'Ada', admin: true };
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('d', worker('d', { manager: { name: 'Sam', slackUserId: SAM } }));
    const made = h.svc.makeTeam(ada, { name: 'Mixed', purpose: 'Writes launch notes.', budgetUSDPerTask: 30, members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }, { workerId: 'd', role: 'Reviews' }] });
    if (!made.ok) throw new Error(made.error);
    // Pat may drop Pat's own worker, not Sam's.
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }] })).toMatchObject({ ok: false, error: expect.stringContaining('take D off') });
    expect(h.svc.editTeam(pat, made.team.id, { members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'd', role: 'Reviews' }] })).toEqual({ ok: true });
    // Where it works needs everyone's manager, or an admin; leaving it as it is doesn't.
    expect(h.svc.editTeam(pat, made.team.id, { workIn: 'somewhere' })).toMatchObject({ ok: false, error: expect.stringContaining('where it works') });
    expect(h.svc.editTeam(pat, made.team.id, { name: 'Mixed crew', workIn: null })).toEqual({ ok: true });
    expect(h.svc.editTeam(ada, made.team.id, { members: [{ workerId: 'a', role: 'Writes' }, { workerId: 'b', role: 'Checks' }] })).toEqual({ ok: true });
  });

  it('renames a worker, keeps its old name finding it, and refuses a name in use', () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    const saved: Worker[] = [];
    const svc = h.svc as unknown as { deps: { workers: { save: (w: Worker) => unknown } } };
    svc.deps.workers.save = (w: Worker) => { saved.push(w); h.roster.set(w.id, w); return { ok: true, worker: w }; };
    expect(h.svc.update(pat, 'a', { name: 'Scout' })).toMatchObject({ ok: true });
    expect(h.roster.get('a')).toMatchObject({ name: 'Scout', formerNames: ['A'] });
    expect(h.svc.resolve(pat, 'scout')?.id).toBe('a');
    expect(h.svc.resolve(pat, 'A')?.id).toBe('a');
    expect(h.audit.some((e) => /Renamed A to Scout/.test(JSON.stringify(e)))).toBe(true);
    // Taken: another's name, or another's old name.
    expect(h.svc.update(pat, 'b', { name: 'scout' })).toMatchObject({ ok: false, error: expect.stringContaining('already a worker called Scout') });
    expect(h.svc.update(pat, 'b', { name: 'A' })).toMatchObject({ ok: false, error: expect.stringContaining('used to be called A') });
    expect(h.svc.update(pat, 'b', { name: ' ' })).toMatchObject({ ok: false });
    // Back to its old name: the alias goes, nothing is lost.
    expect(h.svc.update(pat, 'a', { name: 'A' })).toMatchObject({ ok: true });
    expect(h.roster.get('a')).toMatchObject({ name: 'A', formerNames: ['Scout'] });
    // Someone who doesn't manage it can't rename it.
    expect(h.svc.update(sam, 'a', { name: 'Other' })).toMatchObject({ ok: false });
  });

  it('suggests a crew only from the workers the caller manages, and names the gaps', async () => {
    const h = harness();
    h.roster.set('a', worker('a', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('b', worker('b', { manager: { name: 'Pat', slackUserId: PAT } }));
    h.roster.set('c', worker('c', { manager: { name: 'Sam', slackUserId: SAM } }));
    const res = await h.svc.suggestTeam(pat, 'Writes PR/FAQs');
    expect(h.rosterAsks).toEqual([['a', 'b']]);
    expect(res).toMatchObject({ ok: true, name: 'Pair', members: [{ workerId: 'a', name: 'A' }, { workerId: 'b', name: 'B' }], gaps: [{ job: 'A designer', role: 'Designs the visuals' }] });
    expect(await h.svc.suggestTeam(sam, 'Writes PR/FAQs')).toMatchObject({ ok: false, error: expect.stringContaining('two workers you manage') });
  });
});
