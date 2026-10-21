import { describe, expect, it } from 'vitest';
import { fileKind, fileTime, folderSections, packChangeCard, pieceGroups } from './folderView';
import type { TeamTask } from '@shared/flows/team';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const AT = new Date(2026, 9, 7, 9, 30).getTime();

const task = (names: Array<[string, string, number?]>, stages: string[] = [], pack?: TeamTask['pack']) =>
  ({
    pack,
    files: names.map(([name, author, at]) => ({ name, author, at: at ?? AT })),
    stages: stages.map((title) => ({ kind: 'contribute', title, assignments: [], status: 'done' })),
  }) as unknown as Pick<TeamTask, 'files' | 'stages'>;

describe('folderSections', () => {
  it('groups the folder by what each file is to the task', () => {
    const sections = folderSections(
      task(
        [
          ['brief.md', 'You'],
          ['03-designs-and-feasibility-check-lena.md', 'Lena'],
          ['01-market-and-technical-groundwork-priya.md', 'Priya'],
          ['pack/PROPOSAL.md', 'Coordinator'],
          ['files/lena/designs/00-index.html', 'Lena'],
          ['attachments/screen.png', 'You'],
          ['conversation.md', 'You and the team'],
        ],
        ['Market and technical groundwork', 'First draft', 'Designs and feasibility check'],
      ),
      NOW,
    );
    expect(sections.map((s) => [s.id, s.items.map((i) => i.label)])).toEqual([
      ['pack', ['PROPOSAL.md']],
      ['task', ['Your brief', 'Conversation']],
      ['pieces', ['Market and technical groundwork', 'Designs and feasibility check']],
      ['made', ['00-index.html']],
      ['attachments', ['screen.png']],
    ]);
    const clock = fileTime(AT, NOW);
    expect(sections[2].items[0].detail).toBe(`Stage 1 · Priya · ${clock}`);
    expect(sections[3].items[0]).toMatchObject({ kind: 'page', detail: `designs/ · Lena · ${clock}` });
    expect(sections[0].note).toBe(clock);
  });

  it('marks what the latest pack update rewrote and keeps the versions it replaced', () => {
    const updated = new Date(2026, 9, 7, 14, 10).getTime();
    const sections = folderSections(
      task(
        [
          ['pack/PROPOSAL.md', 'Coordinator', updated],
          ['pack/PLAN.md', 'Coordinator'],
          ['pack-v1/PROPOSAL.md', 'Coordinator'],
          ['pack-v2/PROPOSAL.md', 'Coordinator'],
        ],
        [],
        { summary: '', files: ['pack/PROPOSAL.md', 'pack/PLAN.md'], version: 3, updatedAt: updated },
      ),
      NOW,
    );
    const [pack, earlier] = sections;
    expect(pack.note).toBe(`v3 · ${fileTime(updated, NOW)}`);
    expect(pack.items.map((i) => [i.label, !!i.fresh])).toEqual([
      ['PROPOSAL.md', true],
      ['PLAN.md', false],
    ]);
    expect(earlier).toMatchObject({ id: 'earlier', collapsed: true });
    expect(earlier.items.map((i) => i.detail.split(' · ')[0])).toEqual(['Version 2', 'Version 1']);
  });

  it('says when, as briefly as it can', () => {
    expect(fileTime(new Date(2026, 9, 6, 9, 30).getTime(), NOW)).toMatch(/^Yesterday /);
    expect(fileTime(new Date(2026, 8, 1).getTime(), NOW)).not.toMatch(/:/);
  });

  it('leaves out empty groups', () => {
    expect(folderSections(task([['brief.md', 'You']])).map((s) => s.id)).toEqual(['task']);
  });

  it('names a file by its kind', () => {
    expect(['a.md', 'b.html', 'c.PNG', 'd.csv', 'e.zip'].map(fileKind)).toEqual(['doc', 'page', 'image', 'data', 'other']);
  });

  it('badges only the files the update changed, once that is recorded', () => {
    const sections = folderSections(
      task([['pack/A.md', 'Coordinator'], ['pack/B.md', 'Coordinator']], [], {
        summary: '', files: ['pack/A.md', 'pack/B.md'], version: 2, updatedAt: AT, changed: ['pack/B.md'],
      }),
      NOW,
    );
    expect(sections[0].items.map((i) => [i.label, !!i.fresh])).toEqual([
      ['A.md', false],
      ['B.md', true],
    ]);
  });
});

describe('packChangeCard', () => {
  const files: Array<[string, string]> = [
    ...['A', 'B', 'C', 'D', 'E', 'F'].map((n): [string, string] => [`pack/${n}.md`, 'Coordinator']),
    ...['A', 'B', 'C', 'D', 'F'].map((n): [string, string] => [`pack-v2/${n}.md`, 'Coordinator']),
  ];
  const packFiles = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => `pack/${n}.md`);

  it('is null for a first pack', () => {
    expect(packChangeCard(task(files, [], { summary: '', files: packFiles, version: 1 }), NOW)).toBeNull();
  });

  it('shows the changed files first, says which are new, and folds the rest behind "more"', () => {
    const card = packChangeCard(
      task(files, [], { summary: '', files: packFiles, version: 3, updatedAt: AT, changed: ['pack/B.md', 'pack/E.md'] }),
      NOW,
    )!;
    expect(card).toMatchObject({ version: 3, changedCount: 2, known: true, note: fileTime(AT, NOW) });
    expect(card.shown.map((i) => [i.label, i.detail])).toEqual([
      ['B.md', 'Revised'],
      ['E.md', 'New in v3'],
    ]);
    expect(card.more.map((i) => [i.label, i.detail])).toEqual([
      ['A.md', 'Unchanged since v2'],
      ['C.md', 'Unchanged since v2'],
      ['D.md', 'Unchanged since v2'],
      ['F.md', 'Unchanged since v2'],
    ]);
  });

  it('counts every file when the update predates recording changes, four at a time', () => {
    const card = packChangeCard(task(files, [], { summary: '', files: packFiles, version: 3, updatedAt: AT }), NOW)!;
    expect(card).toMatchObject({ changedCount: 6, known: false });
    expect(card.shown).toHaveLength(4);
    expect(card.more.map((i) => i.label)).toEqual(['E.md', 'F.md']);
    expect(card.shown[0].detail).toBe('Rewritten');
  });
});

describe('pieceGroups', () => {
  it('puts each stage on one row with everyone who worked it and when', () => {
    const t1 = new Date(2026, 9, 7, 12, 56).getTime();
    const t2 = new Date(2026, 9, 7, 13, 2).getTime();
    const groups = pieceGroups(
      task(
        [
          ['01-find-savings-kira.md', 'Kira', t1],
          ['01-find-savings-wes.md', 'Wes', t2],
          ['02-inventory-coordinator.md', 'Coordinator', t2],
          ['notes.md', 'Wes', t2],
          ['pack/PLAN.md', 'Coordinator'],
        ],
        ['Find every saving', 'Savings inventory'],
      ),
      NOW,
    );
    expect(groups.map((g) => [g.key, g.title, g.authors, g.files.map((f) => f.label)])).toEqual([
      ['stage-1', 'Find every saving', ['Kira', 'Wes'], ['Kira', 'Wes']],
      ['stage-2', 'Savings inventory', ['Coordinator'], ['Coordinator']],
      ['file-notes.md', 'notes', ['Wes'], ['Wes']],
    ]);
    expect(groups[0].when).toBe(`Stage 1 · 2 pieces · ${fileTime(t1, NOW)}–${fileTime(t2, NOW)}`);
    expect(groups[1].when).toBe(`Stage 2 · ${fileTime(t2, NOW)}`);
  });
});
