import { describe, expect, it } from 'vitest';
import { fileKind, fileTime, folderSections } from './folderView';
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
});
