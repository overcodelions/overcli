import { describe, expect, it } from 'vitest';
import type { OrgCaller } from '../../shared/org/policy';
import type { ProcessPerson, ProcessState } from '../../shared/org/process';
import { ProcessService, type ProcessTaskLook } from './processes';

const owner: OrgCaller = { name: 'Pat', slackUserId: 'U0PAT', admin: false };
const lead: ProcessPerson = { name: 'Dana', slackUserId: 'U0DANA' };
const judge: OrgCaller = { name: 'Sam', slackUserId: 'U0SAM', admin: false };
const someone: OrgCaller = { name: 'Riley', slackUserId: 'U0RILEY', admin: false };

function harness() {
  let state: ProcessState = { processes: [], items: [] };
  const tasks = new Map<string, ProcessTaskLook>();
  const briefs: Array<{ teamId: string; text: string; by: string; taskId: string; code?: { projectPath: string; startFrom?: string } }> = [];
  const told: Array<{ to: string; text: string; decide: boolean }> = [];
  const cancelled: string[] = [];
  const asked: Array<{ workerId: string; text: string; by: string; askId: string; trusted: boolean }> = [];
  const cancelledAsks: string[] = [];
  let loads = 0;
  let n = 0;
  const clock = { at: 1000 };
  const svc = new ProcessService({
    store: { load: () => (loads++, structuredClone(state)), save: (s) => { state = structuredClone(s); } },
    teams: () => [
      { id: 't-product', name: 'Product', owner: lead },
      { id: 't-build', name: 'Build', owner: { name: 'Lee', slackUserId: 'U0LEE' } },
    ],
    task: (id) => tasks.get(id) ?? null,
    brief: (teamId, text, by, code) => {
      const taskId = `task-${++n}`;
      briefs.push({ teamId, text, by: by.name, taskId, ...(code ? { code } : {}) });
      tasks.set(taskId, { status: 'planning' });
      return { ok: true, taskId };
    },
    readFile: (taskId, name) => `contents of ${name} from ${taskId}`,
    workers: () => [
      { id: 'w-scribe', name: 'Scribe', owner: { name: 'Lee', slackUserId: 'U0LEE' } },
      { id: 'w-ledger', name: 'Ledger', owner: { name: 'Lee', slackUserId: 'U0LEE' } },
    ],
    // Lee manages both; the Ledger is private to Lee.
    workerAccess: (c, id) => (c.admin || c.slackUserId === 'U0LEE' ? 'manage' : id === 'w-ledger' ? null : 'see'),
    askWorker: (workerId, text, by, trusted) => {
      const askId = `ask-${++n}`;
      asked.push({ workerId, text, by: by.name, askId, trusted });
      tasks.set(askId, { status: 'running' });
      return { ok: true, askId };
    },
    workerTask: (id) => tasks.get(id) ?? null,
    cancelTask: (id) => cancelled.push(id),
    cancelAsk: (id) => cancelledAsks.push(id),
    isAdmin: (c) => c.admin,
    groupMembers: (id) => (id === 'team:Product leads' ? [{ name: 'Sam', slackUserId: 'U0SAM' }, { name: 'Ana', slackUserId: 'U0ANA' }] : []),
    notify: (to, text, decide) => told.push({ to: to.name, text, decide: !!decide }),
    decided: (_item, _stage, text, final) => told.push({ to: final ? 'decided' : 'vote', text, decide: false }),
    log: () => {},
    now: () => clock.at + n,
  });
  const make = () =>
    svc.save(owner, {
      name: 'Idea to launch',
      stages: [
        { id: 'prfaq', name: 'PRFAQ', kind: 'team', teamId: 't-product', ask: 'Write the PR/FAQ and define the MLP.' },
        { id: 'validate', name: 'Validate', kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0SAM' }] },
        { id: 'build', name: 'Develop', kind: 'team', teamId: 't-build' },
      ],
    });
  return { svc, tasks, briefs, asked, told, cancelled, cancelledAsks, make, clock, state: () => state, loads: () => loads };
}

describe('processes', () => {
  it('moves an item through team and people stages, handing each pack on', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley', slackUserId: 'U0RILEY' }, made.process.id, { brief: 'Let customers export reports to CSV', source: 'slack' });
    if (!sub.ok) throw new Error(sub.error);

    // Stage 1: briefed as the team's lead, with the stage's ask and the request.
    expect(h.briefs[0]).toMatchObject({ teamId: 't-product', by: 'Dana' });
    expect(h.briefs[0].text).toContain('Write the PR/FAQ and define the MLP.');
    expect(h.briefs[0].text).toContain('Let customers export reports to CSV');
    expect(h.told.some((t) => t.to === 'Riley' && t.text.includes('now at *PRFAQ*'))).toBe(true);

    h.tasks.set('task-1', { status: 'review' });
    h.svc.poll();
    expect(h.state().items[0].stageNote).toBe('Pack waiting on Dana’s sign-off');
    // The pack waits on Dana, the stage's owner, and nobody else.
    const dana = h.svc.get({ name: 'Dana', slackUserId: 'U0DANA', admin: false }, made.process.id);
    const riley = h.svc.get(someone, made.process.id);
    if (!dana.ok || !riley.ok) throw new Error('get');
    expect(dana.items[0]).toMatchObject({ ownerTurn: 'pack', yourTurn: true, waitsOn: 'Dana' });
    expect(riley.items[0]).toMatchObject({ yourTurn: false, waitsOn: 'Dana' });
    expect(h.svc.waitingOn({ name: 'Dana', slackUserId: 'U0DANA' }).map((w) => w.stage)).toEqual(['PRFAQ']);

    h.tasks.set('task-1', { status: 'done', title: 'CSV export PR/FAQ', pack: { summary: 'Customers want CSV.', files: ['pack/PRFAQ.md'] } });
    h.svc.poll();
    const atValidate = h.state().items[0];
    expect(atValidate.stageIndex).toBe(1);
    expect(atValidate.artifacts[0]).toMatchObject({ stageName: 'PRFAQ', title: 'CSV export PR/FAQ' });
    expect(atValidate.ownerTurn).toBeUndefined();
    // Anyone who can see the item opens what a stage handed on, and only that.
    expect(h.svc.artifactFile(someone, atValidate.id, 'task-1', 'pack/PRFAQ.md')).toMatchObject({ ok: true, body: 'contents of pack/PRFAQ.md from task-1' });
    expect(h.svc.artifactFile(someone, atValidate.id, 'task-1', 'secrets.md').ok).toBe(false);
    expect(h.told.find((t) => t.to === 'Sam')).toMatchObject({ decide: true });

    // Only the people deciding (or the owner) approve.
    expect(h.svc.act(someone, atValidate.id, 'approve').ok).toBe(false);
    expect(h.svc.act(judge, atValidate.id, 'approve').ok).toBe(true);

    // Stage 3 gets the earlier pack, files and all.
    expect(h.briefs[1]).toMatchObject({ teamId: 't-build', by: 'Lee' });
    expect(h.briefs[1].text).toContain('## PRFAQ: CSV export PR/FAQ');
    expect(h.briefs[1].text).toContain('contents of pack/PRFAQ.md from task-1');

    h.tasks.set('task-2', { status: 'done', pack: { summary: 'Shipped.', files: [] } });
    h.svc.poll();
    expect(h.state().items[0].status).toBe('done');
    expect(h.told.some((t) => t.to === 'Riley' && t.text.includes('made it through'))).toBe(true);
  });

  it('sends back with a note the earlier team is briefed with', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'Dark mode', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Draft', files: [] } });
    h.svc.poll();
    expect(h.svc.act(judge, sub.item.id, 'sendBack').ok).toBe(false);
    expect(h.svc.act(judge, sub.item.id, 'sendBack', { note: 'Size the market first.' }).ok).toBe(true);
    expect(h.state().items[0].stageIndex).toBe(0);
    expect(h.briefs[1].text).toContain('sent back to this stage by Sam, who said:\nSize the market first.');

    // From further on, the owner picks which earlier stage it goes back to.
    h.tasks.set('task-2', { status: 'done', pack: { summary: 'Sized', files: [] } });
    h.svc.poll();
    expect(h.svc.act(judge, sub.item.id, 'approve').ok).toBe(true);
    expect(h.state().items[0].stageIndex).toBe(2);
    expect(h.svc.act(owner, sub.item.id, 'sendBack', { note: 'Start over.', stageIndex: 0 }).ok).toBe(true);
    expect(h.state().items[0].stageIndex).toBe(0);
  });

  it('says when a team stage is stuck, once, and lets an owner start it again', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'Dark mode', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'failed', error: 'out of budget' });
    h.svc.poll();
    h.svc.poll();
    expect(h.state().items[0].blocked).toContain('out of budget');
    expect(h.told.filter((t) => t.text.includes('is stuck')).length).toBe(2); // Dana and Pat, once each
    expect(h.svc.act(someone, sub.item.id, 'retry').ok).toBe(false);
    expect(h.svc.act({ name: 'Dana', slackUserId: 'U0DANA', admin: false }, sub.item.id, 'retry').ok).toBe(true);
    expect(h.cancelled).toEqual(['task-1']);
    expect(h.state().items[0].blocked).toBeUndefined();
  });

  it('only lets the owner or an admin change a process, and checks its stages', () => {
    const h = harness();
    expect(h.svc.save(owner, { name: 'X', stages: [{ id: 'a', name: 'Build', kind: 'team', teamId: 'nope' }] })).toMatchObject({ ok: false, error: expect.stringContaining('gone') });
    expect(h.svc.save(owner, { name: 'X', stages: [{ id: 'a', name: 'Decide', kind: 'people', approvers: [] }] })).toMatchObject({ ok: false, error: expect.stringContaining('who decides') });
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.save(someone, { id: made.process.id, name: 'Mine now', stages: made.process.stages }).ok).toBe(false);
    expect(h.svc.save({ name: 'Admin', admin: true }, { id: made.process.id, name: 'Renamed', stages: made.process.stages }).ok).toBe(true);
  });

  it('lets one worker take a stage, handing its answer on', () => {
    const h = harness();
    expect(h.svc.save(owner, { name: 'Notes', stages: [{ id: 'w', name: 'Write notes', kind: 'worker' }] })).toMatchObject({ ok: false, error: 'Pick the worker for Write notes.' });
    const made = h.svc.save(owner, {
      name: 'Release notes',
      stages: [
        { id: 'w', name: 'Write notes', kind: 'worker', workerId: 'w-scribe', ask: 'Draft the release notes.' },
        { id: 't', name: 'Publish', kind: 'team', teamId: 't-build' },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'Notes for 4.2', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    // Pat doesn't manage the Scribe: it's asked as a proposal, from Pat.
    expect(h.asked[0]).toMatchObject({ workerId: 'w-scribe', by: 'Pat', trusted: false });
    expect(h.asked[0].text).toContain('Do this stage yourself.');
    h.tasks.set(h.asked[0].askId, { status: 'done', title: 'Scribe', pack: { summary: 'Here are the notes.', files: [] } });
    h.svc.poll();
    expect(h.state().items[0].stageIndex).toBe(1);
    expect(h.briefs[0].text).toContain('## Write notes: Scribe\nHere are the notes.');
  });

  it('lets a group decide: everyone in it is asked, and any one of them can approve', () => {
    const h = harness();
    const made = h.svc.save(owner, {
      name: 'Approvals',
      stages: [
        { id: 'p', name: 'Plan', kind: 'team', teamId: 't-product' },
        { id: 'ok', name: 'Approve', kind: 'people', approvers: [], approverGroups: [{ id: 'team:Product leads', name: 'Product leads' }] },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'Dark mode', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Plan', files: [] } });
    h.svc.poll();
    expect(h.told.filter((t) => t.decide).map((t) => t.to)).toEqual(['Sam', 'Ana']);
    expect(h.state().items[0].stageNote).toBe('Waiting on Product leads');
    expect(h.svc.waitingOn({ name: 'Ana', slackUserId: 'U0ANA' })).toHaveLength(1);
    expect(h.svc.act({ name: 'Ana', slackUserId: 'U0ANA', admin: false }, sub.item.id, 'approve').ok).toBe(true);
  });

  it('waits for enough approvals when a decision needs more than one, and lets anyone send it back at once', () => {
    const h = harness();
    expect(h.svc.save(owner, { name: 'X', stages: [{ id: 'ok', name: 'Approve', kind: 'people', approvers: [{ name: 'Sam' }], needs: 2 }] })).toMatchObject({ ok: false, error: expect.stringContaining('needs 2 approvals but only 1') });
    const made = h.svc.save(owner, {
      name: 'Two keys',
      stages: [
        { id: 'p', name: 'Plan', kind: 'team', teamId: 't-product' },
        { id: 'ok', name: 'Approve', kind: 'people', approvers: [], approverGroups: [{ id: 'team:Product leads', name: 'Product leads' }], needs: 'all' },
        { id: 'b', name: 'Build', kind: 'team', teamId: 't-build' },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'Dark mode', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Plan', files: [] } });
    h.svc.poll();
    const sam = { name: 'Sam', slackUserId: 'U0SAM', admin: false };
    const ana = { name: 'Ana', slackUserId: 'U0ANA', admin: false };
    expect(h.svc.act(sam, sub.item.id, 'approve').ok).toBe(true);
    expect(h.state().items[0]).toMatchObject({ stageIndex: 1, stageNote: '1 of 2 approved, waiting on 1 more' });
    expect(h.svc.act(sam, sub.item.id, 'approve')).toMatchObject({ ok: false, error: 'You already approved this.' });
    expect(h.svc.waitingOn(sam)).toHaveLength(0);
    expect(h.svc.waitingOn(ana)).toHaveLength(1);
    expect(h.svc.act(ana, sub.item.id, 'approve').ok).toBe(true);
    expect(h.state().items[0].stageIndex).toBe(2);
    expect(h.state().items[0].votes).toBeUndefined();
    expect(h.told.filter((t) => t.to === 'decided').map((t) => t.text)).toEqual(['Approved by Sam, Ana.']);

    // Back at the decision, one send back is enough.
    expect(h.svc.act(owner, sub.item.id, 'move', { stageIndex: 1 }).ok).toBe(true);
    expect(h.svc.act(ana, sub.item.id, 'sendBack', { note: 'Needs pricing.' }).ok).toBe(true);
    expect(h.state().items[0].stageIndex).toBe(0);
  });

  it('puts an item in on each occurrence of a schedule, once, from the owner', () => {
    const h = harness();
    h.clock.at = new Date(2026, 9, 19, 8, 0).getTime(); // a Monday, 08:00
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    expect(h.svc.addSchedule(someone, made.process.id, { cadence: { kind: 'daily', time: '09:00', days: [1] }, title: 'Weekly review', brief: 'Review the week' }).ok).toBe(false);
    const added = h.svc.addSchedule(owner, made.process.id, { cadence: { kind: 'daily', time: '09:00', days: [1] }, title: 'Weekly review', brief: 'Review the week' });
    if (!added.ok) throw new Error(added.error);
    h.svc.poll();
    expect(h.state().items).toHaveLength(0);
    h.clock.at = new Date(2026, 9, 19, 9, 1).getTime();
    h.svc.poll();
    h.svc.poll();
    expect(h.state().items).toHaveLength(1);
    expect(h.state().items[0]).toMatchObject({ source: 'schedule', initiator: { name: 'Pat' } });
    expect(h.state().items[0].title).toMatch(/^Weekly review · Oct 19, 2026$/);
    expect(h.svc.nextAt(h.state().processes[0].schedules![0])).toBe(new Date(2026, 9, 26, 9, 0).getTime());
    expect(h.svc.removeSchedule(owner, made.process.id, added.schedule.id).ok).toBe(true);
  });

  it('waits before a stage, and repeats one, each run building on the last', () => {
    const h = harness();
    const DAY = 24 * 3_600_000;
    h.clock.at = new Date(2026, 9, 1, 9, 0).getTime();
    const made = h.svc.save(owner, {
      name: 'Launch',
      stages: [
        { id: 'ship', name: 'Ship', kind: 'team', teamId: 't-build' },
        { id: 'verify', name: 'Verify adoption', kind: 'team', teamId: 't-product', delayDays: 14, repeat: { everyDays: 7, times: 2 } },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'CSV export', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Shipped.', files: [] } });
    h.svc.poll();
    expect(h.state().items[0]).toMatchObject({ stageIndex: 1, stageNote: 'Starts Thu, Oct 15' });
    expect(h.briefs).toHaveLength(1);

    h.clock.at += 14 * DAY;
    h.svc.poll();
    expect(h.briefs).toHaveLength(2);
    expect(h.briefs[1].text).toContain('This is run 1 of 2');
    h.tasks.set('task-2', { status: 'done', title: 'Adoption', pack: { summary: '12% used it.', files: [] } });
    h.svc.poll();
    expect(h.state().items[0]).toMatchObject({ stageIndex: 1, runs: 1, stageNote: 'Run 2 of 2 starts Thu, Oct 22' });

    // The owner can start the next run early.
    expect(h.svc.act(owner, sub.item.id, 'startNow').ok).toBe(true);
    expect(h.briefs[2].text).toContain('This is run 2 of 2');
    expect(h.briefs[2].text).toContain('## Adoption · run 1 of 2\n12% used it.');
    h.tasks.set('task-3', { status: 'done', title: 'Adoption', pack: { summary: '19% used it.', files: [] } });
    h.svc.poll();
    expect(h.state().items[0].status).toBe('done');
    expect(h.state().items[0].artifacts.map((a) => a.title)).toEqual(['Ship', 'Adoption · run 1 of 2', 'Adoption · run 2 of 2']);
  });

  it('works where its code lives, each team stage starting from the branch the last one left', () => {
    const h = harness();
    const made = h.svc.save(owner, {
      name: 'Ship it',
      codeIn: { name: 'acme-web', path: '/repos/acme-web' },
      stages: [
        { id: 'dev', name: 'Develop', kind: 'team', teamId: 't-build' },
        { id: 'qa', name: 'Test', kind: 'team', teamId: 't-build' },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley' }, made.process.id, { brief: 'CSV export', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    expect(h.briefs[0].code).toEqual({ projectPath: '/repos/acme-web' });
    h.tasks.set('task-1', { status: 'done', branch: 'team/csv-export', pack: { summary: 'Built.', files: [] } });
    h.svc.poll();
    expect(h.briefs[1].code).toEqual({ projectPath: '/repos/acme-web', startFrom: 'team/csv-export' });
    expect(h.briefs[1].text).toContain('The code so far is on the branch `team/csv-export` in acme-web.');
    expect(h.state().items[0].artifacts[0].branch).toBe('team/csv-export');
  });

  it('runs a worker stage as from its manager only when its manager put it there', () => {
    const h = harness();
    const lee: OrgCaller = { name: 'Lee', slackUserId: 'U0LEE', admin: false };
    const stages = [{ id: 'w', name: 'Write notes', kind: 'worker' as const, workerId: 'w-scribe' }];
    // A private worker can't be put in by someone who can't see it.
    expect(h.svc.save(owner, { name: 'Ledger', stages: [{ id: 'w', name: 'Books', kind: 'worker', workerId: 'w-ledger' }] })).toMatchObject({ ok: false, error: expect.stringContaining("can't use that worker") });
    // A form can't claim the trust for itself.
    const claimed = h.svc.save(owner, { name: 'Notes', stages: [{ ...stages[0], trusted: true }] });
    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.process.stages[0].trusted).toBeUndefined();

    // Pat saving it again doesn't vouch for it; an admin saving it does.
    const again = h.svc.save(owner, { id: claimed.process.id, name: 'Notes', stages: claimed.process.stages });
    if (!again.ok) throw new Error(again.error);
    expect(again.process.stages[0].trusted).toBeUndefined();
    const vouched = h.svc.save({ name: 'Admin', admin: true }, { id: claimed.process.id, name: 'Notes', stages: again.process.stages });
    if (!vouched.ok) throw new Error(vouched.error);
    expect(vouched.process.stages[0].trusted).toBe(true);

    const made = h.svc.save(lee, { name: 'Lee notes', stages });
    if (!made.ok) throw new Error(made.error);
    expect(made.process.stages[0].trusted).toBe(true);
    // Kept when the stage is unchanged, whoever saves it next.
    const renamed = h.svc.save({ name: 'Admin', admin: true }, { id: made.process.id, name: 'Lee notes v2', stages: made.process.stages });
    if (!renamed.ok) throw new Error(renamed.error);
    expect(renamed.process.stages[0].trusted).toBe(true);
    h.svc.submit({ name: 'Riley', slackUserId: 'U0RILEY' }, made.process.id, { brief: 'Notes for 4.3', source: 'console' });
    expect(h.asked.at(-1)).toMatchObject({ by: 'Lee', trusted: true });
  });

  it('only lets an admin or the real lead name someone else to lead a stage', () => {
    const h = harness();
    const lee: OrgCaller = { name: 'Lee', slackUserId: 'U0LEE', admin: false };
    const build = (who: ProcessPerson) => [{ id: 'b', name: 'Build', kind: 'team' as const, teamId: 't-build', owner: who }];
    expect(h.svc.save(someone, { name: 'Mine', stages: build({ name: 'Riley', slackUserId: 'U0RILEY' }) })).toMatchObject({ ok: false, error: expect.stringContaining('Only an admin or Lee') });
    expect(h.svc.save(someone, { name: 'Lee leads', stages: build({ name: 'Lee', slackUserId: 'U0LEE' }) }).ok).toBe(true);
    expect(h.svc.save(lee, { name: 'Lee hands off', stages: build({ name: 'Riley', slackUserId: 'U0RILEY' }) }).ok).toBe(true);
    const byAdmin = h.svc.save({ name: 'Admin', admin: true }, { name: 'Picked', stages: build({ name: 'Riley', slackUserId: 'U0RILEY' }) });
    if (!byAdmin.ok) throw new Error(byAdmin.error);
    // The admin's pick survives the owner saving it again unchanged.
    expect(h.svc.save({ name: 'Admin', admin: true }, { id: byAdmin.process.id, name: 'Picked', owner: { name: 'Riley', slackUserId: 'U0RILEY' }, stages: byAdmin.process.stages }).ok).toBe(true);
    expect(h.svc.save(someone, { id: byAdmin.process.id, name: 'Picked again', stages: byAdmin.process.stages }).ok).toBe(true);
  });

  it('shows an item and its files only to the people in it', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley', slackUserId: 'U0RILEY' }, made.process.id, { brief: 'Let customers export reports to CSV', source: 'slack' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Customers want CSV.', files: ['pack/PRFAQ.md'] } });
    h.svc.poll();
    const outsider: OrgCaller = { name: 'Riley', slackUserId: 'U0OTHER', admin: false };
    const seen = (c: OrgCaller) => {
      const got = h.svc.get(c, made.process.id);
      return got.ok ? got.items.length : -1;
    };
    expect(seen(owner)).toBe(1);
    expect(seen(someone)).toBe(1);
    expect(seen(judge)).toBe(1);
    expect(seen({ name: 'Dana', slackUserId: 'U0DANA', admin: false })).toBe(1);
    // Same name, different person: sees the process, not what's in it.
    expect(seen(outsider)).toBe(0);
    expect(h.svc.inFlight(outsider)).toHaveLength(0);
    expect(h.svc.artifactFile(outsider, sub.item.id, 'task-1', 'pack/PRFAQ.md').ok).toBe(false);
    expect(h.svc.artifactFile(judge, sub.item.id, 'task-1', 'pack/PRFAQ.md').ok).toBe(true);
    expect(h.svc.act(outsider, sub.item.id, 'note', { note: 'mine now' }).ok).toBe(false);
    expect(h.svc.act(outsider, sub.item.id, 'approve').ok).toBe(false);
  });

  it('refuses a decision for a stage the item has left, and settles its messages when moved', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const sub = h.svc.submit({ name: 'Riley', slackUserId: 'U0RILEY' }, made.process.id, { brief: 'Dark mode', source: 'console' });
    if (!sub.ok) throw new Error(sub.error);
    h.tasks.set('task-1', { status: 'done', pack: { summary: 'Plan', files: [] } });
    h.svc.poll();
    expect(h.state().items[0].stageIndex).toBe(1);
    // The owner moves it back to PRFAQ: Sam's buttons are settled.
    expect(h.svc.act(owner, sub.item.id, 'move', { stageIndex: 0 }).ok).toBe(true);
    expect(h.told.some((t) => t.to === 'decided' && t.text.includes('Moved to PRFAQ'))).toBe(true);
    // A stale button from Validate does nothing, even once it's back there.
    h.tasks.set('task-2', { status: 'done', pack: { summary: 'Plan', files: [] } });
    expect(h.svc.act(judge, sub.item.id, 'approve', { stageId: 'prfaq' }).ok).toBe(false);
    expect(h.svc.act(judge, sub.item.id, 'approve', { stageId: 'validate' })).toMatchObject({ ok: false, error: expect.stringContaining('moved on') });
    h.svc.poll();
    expect(h.svc.act(judge, sub.item.id, 'approve', { stageId: 'validate' }).ok).toBe(true);
  });

  it('stops a worker stage’s ask when the item is stopped, retried, moved or its stage removed', () => {
    const h = harness();
    const made = h.svc.save(owner, {
      name: 'Notes',
      stages: [
        { id: 'w', name: 'Write notes', kind: 'worker', workerId: 'w-scribe' },
        { id: 'ok', name: 'Approve', kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0SAM' }] },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const one = h.svc.submit(someone, made.process.id, { brief: 'Notes for 4.2', source: 'console' });
    const two = h.svc.submit(someone, made.process.id, { brief: 'Notes for 4.3', source: 'console' });
    if (!one.ok || !two.ok) throw new Error('submit');
    expect(h.svc.act(owner, one.item.id, 'retry').ok).toBe(true);
    expect(h.cancelledAsks).toEqual([h.asked[0].askId]);
    expect(h.svc.act(owner, one.item.id, 'sendBack', { note: 'Shorter, please.' }).ok).toBe(true);
    expect(h.cancelledAsks).toEqual([h.asked[0].askId, h.asked[2].askId]);
    expect(h.svc.act(owner, one.item.id, 'stop').ok).toBe(true);
    expect(h.cancelledAsks).toEqual([h.asked[0].askId, h.asked[2].askId, h.asked[3].askId]);
    // The worker stage goes: the ask it started stops with it.
    expect(h.svc.save(owner, { id: made.process.id, name: 'Notes', stages: [made.process.stages[1]] }).ok).toBe(true);
    expect(h.cancelledAsks).toContain(h.asked[1].askId);
    expect(h.cancelled).toEqual([]);
  });

  it('reads its store once, not on every look', () => {
    const h = harness();
    const made = h.make();
    if (!made.ok) throw new Error(made.error);
    const before = h.loads();
    for (let i = 0; i < 5; i++) {
      h.svc.list(owner);
      h.svc.get(owner, made.process.id);
      h.svc.poll();
    }
    expect(h.loads()).toBe(before);
  });
});
