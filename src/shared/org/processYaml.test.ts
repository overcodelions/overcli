import { describe, expect, it } from 'vitest';
import { parseProcessAccess, type ProcessDef } from './process';
import { processFromYaml, processToYaml, type ProcessYamlNames } from './processYaml';

const names: ProcessYamlNames = {
  teams: [{ id: 't-product', name: 'Product Team' }, { id: 't-design', name: 'Design Team' }],
  workers: [{ id: 'w-ana', name: 'Ana' }, { id: 'w-fix', name: 'Fixer' }],
  people: [{ name: 'Pat Doe', slackUserId: 'U0ACMEPAT' }, { name: 'Sam', slackUserId: 'U0ACMESAM' }, { name: 'Twin', slackUserId: 'U0ACMET1' }, { name: 'Twin', slackUserId: 'U0ACMET2' }],
  groups: [{ id: 'team:Leads', name: 'Leads' }],
};

const FULL = `
name: Idea to launch
short_name: itl
purpose: From idea to first build.
owner: Pat Doe
access: private
code_in: acme-repo
stages:
  - name: Product and brief
    team: product team
    lead: Pat Doe
    job: Produce a brief.
  - name: Architecture
    team: Design Team
    job: >
      Agree a design.
  - name: Go or no-go
    decide: [Sam, Leads]
    needs: all
    send_back_to: Architecture
    job: Approve it.
  - name: Ticketing
    worker: Ana
    delay_days: 2
  - name: Build
    worker: Fixer
    repeat: { every_days: 7, times: 2 }
`;

const read = (source: string, n: ProcessYamlNames = names) => {
  const res = processFromYaml(source, n);
  if (!res.ok) throw new Error(res.error);
  return res;
};

describe('reading a process file', () => {
  it('turns names into what the editor holds, with nothing to flag', () => {
    const { draft, notes } = read(FULL);
    expect(notes).toEqual([]);
    expect(draft).toMatchObject({ name: 'Idea to launch', shortName: 'itl', purpose: 'From idea to first build.', owner: { name: 'Pat Doe', slackUserId: 'U0ACMEPAT' }, access: { who: 'private' }, codeIn: 'acme-repo' });
    expect(draft.stages[0]).toMatchObject({ kind: 'team', teamId: 't-product', owner: { slackUserId: 'U0ACMEPAT' }, ask: 'Produce a brief.' });
    expect(draft.stages[1].ask).toBe('Agree a design.');
    expect(draft.stages[2]).toMatchObject({ kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }], approverGroups: [{ id: 'team:Leads', name: 'Leads' }], needs: 'all', sendBackTo: draft.stages[1].id });
    expect(draft.stages[3]).toMatchObject({ kind: 'worker', workerId: 'w-ana', delayDays: 2 });
    expect(draft.stages[4]).toMatchObject({ kind: 'worker', workerId: 'w-fix', repeat: { everyDays: 7, times: 2 } });
  });

  it('never carries a trust setting or an id from the file', () => {
    const { draft, notes } = read('name: X\nstages:\n  - name: A\n    worker: Ana\n    trusted: true\n    workerId: w-fix\n    id: forged\n');
    expect(draft.stages[0]).not.toHaveProperty('trusted');
    expect(draft.stages[0].workerId).toBe('w-ana');
    expect(draft.stages[0].id).not.toBe('forged');
    expect(notes.join(' ')).toContain('Ignored `trusted`');
  });

  it('says what it can’t match rather than guessing', () => {
    const { draft, notes } = read(`
name: X
owner: Twin
stages:
  - name: A
    team: Nobody Team
    lead: Stranger
  - name: B
    worker: Nobody
  - name: C
    decide: [Twin]
    send_back_to: Nowhere
  - name: D
`);
    expect(draft.owner).toBeUndefined();
    expect(draft.stages[0].teamId).toBeUndefined();
    expect(draft.stages[0].owner).toBeUndefined();
    expect(draft.stages[1].workerId).toBeUndefined();
    expect(draft.stages[2].approvers).toEqual([]);
    const said = notes.join('\n');
    expect(said).toContain('More than one person is called Twin');
    expect(said).toContain('no team called Nobody Team');
    expect(said).toContain('Nobody called Stranger in Slack');
    expect(said).toContain('no worker called Nobody');
    expect(said).toContain('sends back to Nowhere');
    expect(said).toContain('D doesn’t say who does it');
  });

  it('takes a Slack handle in place of a name, and won’t guess between two', () => {
    const people = [{ name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY', handle: 'holly' }, { name: 'One', slackUserId: 'U0ACMEONE', handle: 'twin' }, { name: 'Two', slackUserId: 'U0ACMETWO', handle: 'twin' }];
    const { draft, notes } = read('name: X\nowner: "@holly"\nstages:\n  - name: A\n    team: Design Team\n    lead: holly\n  - name: B\n    team: Design Team\n    lead: twin\n', { ...names, people });
    expect(draft.owner).toEqual({ name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY' });
    expect(draft.stages[0].owner).toEqual({ name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY' });
    expect(draft.stages[1].owner).toBeUndefined();
    expect(notes.join(' ')).toContain('More than one person is called twin');
  });

  it('flags two stages with one name, and a stage that names two doers', () => {
    const { notes } = read('name: X\nstages:\n  - name: A\n    team: Design Team\n  - name: a\n    team: Design Team\n    worker: Ana\n');
    expect(notes.join(' ')).toContain('Two stages are called a');
    expect(notes.join(' ')).toContain('more than one of team, worker and decide');
  });

  it('refuses what isn’t a process at all', () => {
    expect(processFromYaml('', names)).toMatchObject({ ok: false });
    expect(processFromYaml('name: [unclosed', names)).toMatchObject({ ok: false, error: expect.stringContaining('valid YAML') });
    expect(processFromYaml('- a\n- b', names)).toMatchObject({ ok: false });
    expect(processFromYaml('stages:\n  - name: A\n', names)).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(processFromYaml('name: X\n', names)).toMatchObject({ ok: false, error: expect.stringContaining('stages') });
    expect(processFromYaml(`name: X\nstages:\n${'  - name: A\n'.repeat(21)}`, names)).toMatchObject({ ok: false, error: expect.stringContaining('at most') });
    expect(processFromYaml(`name: ${'x'.repeat(100_001)}`, names)).toMatchObject({ ok: false, error: expect.stringContaining('too long') });
  });

  it('keeps a stage’s id by its name when it replaces a process, so items stay put', () => {
    const { draft } = read('name: X\nstages:\n  - name: Fresh\n    team: Design Team\n  - name: Architecture\n    team: Design Team\n', { ...names, existingStages: [{ id: 'old-arch', name: 'architecture' }] });
    expect(draft.stages[1].id).toBe('old-arch');
    expect(draft.stages[0].id).not.toBe('old-arch');
  });

  it('reads who can start it in a form the server accepts', () => {
    const { draft } = read('name: X\naccess: { who: people, people: [Sam], groups: [Leads] }\nstages:\n  - name: A\n    team: Design Team\n');
    expect(parseProcessAccess(draft.access)).toEqual({ who: 'people', groups: [{ id: 'team:Leads', name: 'Leads' }], people: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }] });
    expect(parseProcessAccess(read('name: X\naccess: everyone\nstages:\n  - name: A\n    team: Design Team\n').draft.access)).toEqual({ who: 'everyone' });
    // A wrong setting reaches the save, which refuses it.
    expect(typeof parseProcessAccess(read('name: X\naccess: nobody\nstages:\n  - name: A\n    team: Design Team\n').draft.access)).toBe('string');
  });

  it('reads what a people stage asks them to fill in', () => {
    const { draft } = read('name: X\nstages:\n  - name: A\n    decide: [Sam]\n    fields:\n      - Budget code\n      - { label: Size, kind: choice, options: [S, L], required: true }\n');
    expect(draft.stages[0]).toMatchObject({ mode: 'input', fields: [{ id: 'f1', label: 'Budget code', kind: 'text' }, { id: 'f2', label: 'Size', kind: 'choice', options: ['S', 'L'], required: true }] });
  });

  it('won’t expand a file’s aliases without limit', () => {
    const bomb = `a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [${'*a,'.repeat(9)}*a]\nc: &c [${'*b,'.repeat(9)}*b]\nd: &d [${'*c,'.repeat(9)}*c]\nname: X\nstages: [${'*d,'.repeat(9)}*d]\n`;
    expect(processFromYaml(bomb, names).ok).toBe(false);
  });
});

describe('writing a process file', () => {
  const def: ProcessDef = {
    id: 'p1',
    name: 'Idea to launch',
    shortName: 'itl',
    purpose: 'From idea to first build.',
    owner: { name: 'Pat Doe', slackUserId: 'U0ACMEPAT' },
    access: { who: 'private' },
    codeIn: { name: 'acme-repo', path: '/secret/path' },
    createdBy: 'Pat',
    createdAt: 0,
    updatedAt: 0,
    stages: [
      { id: 's1', name: 'Product', kind: 'team', teamId: 't-product', owner: { name: 'Sam', slackUserId: 'U0ACMESAM' }, ask: 'Produce a brief.' },
      { id: 's2', name: 'Go', kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }], needs: 'all', sendBackTo: 's1' },
      { id: 's3', name: 'Ticket', kind: 'worker', workerId: 'w-ana', trusted: true, delayDays: 1 },
    ],
  };

  it('uses names, and leaves out ids, paths and trust', () => {
    const y = processToYaml(def, names);
    expect(y).toContain('team: Product Team');
    expect(y).toContain('send_back_to: Product');
    expect(y).toContain('code_in: acme-repo');
    for (const hidden of ['t-product', 'w-ana', 'U0ACME', '/secret/path', 'trusted', 's1']) expect(y).not.toContain(hidden);
  });

  it('reads back as the same process', () => {
    const { draft, notes } = read(processToYaml(def, names));
    expect(notes).toEqual([]);
    expect(draft).toMatchObject({ name: def.name, shortName: 'itl', owner: def.owner, access: { who: 'private' }, codeIn: 'acme-repo' });
    expect(draft.stages.map((s) => [s.name, s.kind, s.teamId, s.workerId, s.ask, s.needs, s.delayDays])).toEqual([
      ['Product', 'team', 't-product', undefined, 'Produce a brief.', undefined, undefined],
      ['Go', 'people', undefined, undefined, undefined, 'all', undefined],
      ['Ticket', 'worker', undefined, 'w-ana', undefined, undefined, 1],
    ]);
    expect(draft.stages[1].sendBackTo).toBe(draft.stages[0].id);
  });

  it('leaves out a short name nobody set', () => {
    expect(processToYaml({ ...def, shortNameAuto: true }, names)).not.toContain('short_name');
  });
});
