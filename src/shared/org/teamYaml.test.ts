import { describe, expect, it } from 'vitest';
import { processFromYaml } from './processYaml';
import { teamFromYaml, teamToYaml, teamWorkerFiles } from './teamYaml';

const workers = [{ id: 'w-lena', name: 'Lena' }, { id: 'w-vera', name: 'Omar' }, { id: 'w-a', name: 'Twin' }, { id: 'w-b', name: 'Twin' }];
const read = (source: string, places?: string[]) => {
  const res = teamFromYaml(source, { workers, ...(places ? { places } : {}) });
  if (!res.ok) throw new Error(res.error);
  return res;
};

describe('reading a team file', () => {
  it('turns names into what the form holds', () => {
    const { draft, notes, missing } = read(`
name: Design Team
short_name: arch
purpose: Designs new work.
members:
  - worker: lena
    role: Chief Architect
budget_per_task: 75
works_in: acme-repo
who_can_give_tasks: org
pieces_ask_first: true
checkpoints: { ask_first: false, final_review: true, read_draft_first: false, approve_follow_up_work: true }
guidance: Prefer small changes.
`, ['acme-repo']);
    expect(notes).toEqual([]);
    expect(missing).toEqual({ workers: [], places: [] });
    expect(draft).toEqual({
      name: 'Design Team',
      shortName: 'arch',
      purpose: 'Designs new work.',
      members: [{ workerId: 'w-lena', name: 'Lena', role: 'Chief Architect' }],
      budgetUSDPerTask: 75,
      workIn: 'acme-repo',
      whoCanBrief: 'org',
      piecesAskFirst: true,
      checkpoints: { askFirst: false, finalReview: true, reviewBeforeChallenge: false, approveRoomWork: true },
      guidance: 'Prefer small changes.',
    });
  });

  it('says what isn’t here yet, separately from what merely needs a look', () => {
    const { draft, notes, missing } = read('name: T\nmembers:\n  - worker: Ghost\n  - worker: Twin\n  - worker: Lena\n  - Lena\nworks_in: gone\ntrusted: true\nbudget_per_task: free\n', ['acme-repo']);
    expect(missing).toEqual({ workers: ['Ghost'], places: ['gone'] });
    expect(draft.members.map((m) => m.name)).toEqual(['Lena']);
    expect(draft.workIn).toBeUndefined();
    expect(draft.budgetUSDPerTask).toBeUndefined();
    const said = notes.join('\n');
    expect(said).toContain('No worker called Ghost');
    expect(said).toContain('More than one worker is called Twin');
    expect(said).toContain('Lena is listed twice');
    expect(said).toContain('Ignored `trusted`');
    expect(said).toContain('budget_per_task');
  });

  it('refuses what isn’t a team at all', () => {
    expect(teamFromYaml('', { workers })).toMatchObject({ ok: false });
    expect(teamFromYaml('name: [', { workers })).toMatchObject({ ok: false, error: expect.stringContaining('valid YAML') });
    expect(teamFromYaml('members:\n  - Lena\n', { workers })).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(teamFromYaml('name: T\n', { workers })).toMatchObject({ ok: false, error: expect.stringContaining('members') });
  });
});

describe('writing a team file', () => {
  const team = {
    name: 'Design Team',
    shortName: 'arch',
    purpose: 'Designs new work.',
    guidance: 'Prefer small changes.',
    budgetUSDPerTask: 75,
    workInLabel: 'Workspace: acme',
    whoCanBrief: 'org',
    piecesAskFirst: false,
    checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true, approveRoomWork: true },
    members: [{ workerId: 'w-lena', name: 'Lena', role: 'Chief Architect' }],
  };

  it('reads back as the same team, with no ids', () => {
    const y = teamToYaml(team);
    expect(y).not.toContain('w-lena');
    const { draft, notes } = read(y, ['acme']);
    expect(notes).toEqual([]);
    expect(draft).toMatchObject({ name: 'Design Team', shortName: 'arch', budgetUSDPerTask: 75, workIn: 'acme', whoCanBrief: 'org', piecesAskFirst: false, guidance: 'Prefer small changes.', members: [{ workerId: 'w-lena', role: 'Chief Architect' }] });
    expect(draft.checkpoints).toEqual(team.checkpoints);
  });

  it('leaves out a short name nobody set, and a place it only knows as a path', () => {
    const y = teamToYaml({ ...team, shortNameAuto: true, workInLabel: '/data/somewhere' });
    expect(y).not.toContain('short_name');
    expect(y).not.toContain('works_in');
    expect(y).not.toContain('/data/somewhere');
  });
});

describe('what a process file needs that isn’t here', () => {
  const names = { teams: [{ id: 't', name: 'Here Team' }], workers: [{ id: 'w', name: 'Here' }], people: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }], places: ['acme-repo'] };

  it('lists it by kind, once each', () => {
    const res = processFromYaml(`
name: P
owner: Nobody One
code_in: gone-repo
stages:
  - name: A
    team: Gone Team
    lead: Nobody Two
  - name: B
    team: Gone Team
  - name: C
    worker: Gone Worker
  - name: D
    decide: [Nobody Two]
  - name: E
    team: Here Team
`, names);
    if (!res.ok) throw new Error(res.error);
    expect(res.missing).toEqual({ teams: ['Gone Team'], workers: ['Gone Worker'], people: ['Nobody Two', 'Nobody One'], places: ['gone-repo'] });
    expect(res.draft.codeIn).toBeUndefined();
  });

  it('is empty when everything is here', () => {
    const res = processFromYaml('name: P\ncode_in: acme-repo\nstages:\n  - name: A\n    team: Here Team\n', names);
    if (!res.ok) throw new Error(res.error);
    expect(res.missing).toEqual({ teams: [], workers: [], people: [], places: [] });
    expect(res.draft.codeIn).toBe('acme-repo');
  });
});

describe('a team file with its members’ worker files', () => {
  const team = { name: 'Design Team', budgetUSDPerTask: 50, checkpoints: {}, members: [{ name: 'Lena', role: 'Lead' }, { name: 'Nadia', role: 'Research' }] };
  const files = [
    { name: 'Lena', sourceId: 'src-lena', yaml: 'worker:\n  name: Lena\n' },
    { name: 'Nadia', sourceId: 'src-nadia', yaml: 'worker:\n  name: Nadia\n  jobDescription: |\n    Digs.\n' },
  ];

  it('carries them last and reads them back', () => {
    const yaml = teamToYaml(team, files);
    expect(yaml.indexOf('worker_files')).toBeGreaterThan(yaml.indexOf('checkpoints'));
    expect(teamWorkerFiles(yaml)).toEqual({ ok: true, files });
  });

  it('uses members already here, and brings the rest from their files', () => {
    const { draft, notes, missing } = read(teamToYaml(team, files));
    expect(draft.members).toEqual([{ workerId: 'w-lena', name: 'Lena', role: 'Lead' }]);
    expect(draft.bring).toEqual([{ name: 'Nadia', role: 'Research' }]);
    expect(missing.workers).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('still says who is missing when the file doesn’t carry them', () => {
    const { draft, missing } = read(teamToYaml(team, files.slice(0, 1)));
    expect(draft.bring).toBeUndefined();
    expect(missing.workers).toEqual(['Nadia']);
  });

  it('allows a long file only for its worker files', () => {
    const big = 'x'.repeat(200_000);
    expect(teamFromYaml(teamToYaml(team, [{ name: 'Nadia', yaml: big }]), { workers }).ok).toBe(true);
    expect(teamFromYaml(teamToYaml({ ...team, purpose: big }), { workers })).toMatchObject({ ok: false });
  });
});
