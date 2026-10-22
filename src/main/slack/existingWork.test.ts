import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../org/orgService';
import { contentWords, declined, isLookup, libraryCandidates, matchExisting, roomText, score, summarize, whenText, type WorkCandidate } from './existingWork';

const NOW = new Date('2026-10-20T15:00:00').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ROADMAP: WorkCandidate = {
  hit: { kind: 'team', title: 'Q1 2027 roadmap: company announcement and customer-facing version', who: 'Product Team', at: NOW - 3 * HOUR, teamTaskId: 't-1', teamId: 'team-product' },
  body: 'The Q1 2027 roadmap has three themes. Reporting comes first. Then the mobile app. Then integrations, last of all.',
  group: 'task:t-1',
};

describe('existing work', () => {
  it('reads questions and lookups as such, and requests to make something as not', () => {
    for (const q of ['whats the roadmap for q1 2027', "What's the latest pricing deck", 'where is the onboarding guide', 'show me the churn report', 'do we have a PR/FAQ for exports', 'is there a launch plan', 'status of the Q3 review', 'the roadmap for next quarter?', 'find the security questionnaire']) {
      expect(isLookup(q), q).toBe(true);
    }
    for (const r of ['write me a plan for the Q1 launch', 'add an export button to the reports page', 'can you write a roadmap for Q1?', 'please draft the release notes?', 'Triage fix this']) {
      expect(isLookup(r), r).toBe(false);
    }
  });

  it('keeps the words that carry the subject: years and quarters too', () => {
    expect(contentWords('whats the roadmap for q1 2027')).toEqual(['roadmap', 'q1', '2027']);
    expect(contentWords("What's the status of the roadmaps?")).toEqual(['roadmap']);
    expect(contentWords('is there anything')).toEqual(['anything']);
  });

  it('shows a strong match: most of the words, title weighted, recent, a team task first', () => {
    const hits = matchExisting('whats the roadmap for q1 2027', [ROADMAP], NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'team', who: 'Product Team', teamTaskId: 't-1' });
    expect(hits[0].weak).toBeUndefined();
    expect(hits[0].summary).toBe('The Q1 2027 roadmap has three themes. Reporting comes first. Then the mobile app.');

    // A file kept from the same task: the task, once.
    const file: WorkCandidate = { hit: { ...ROADMAP.hit, kind: 'file', title: 'Q1 2027 roadmap (customer-facing)' }, body: ROADMAP.body, group: 'task:t-1' };
    const answer: WorkCandidate = { hit: { kind: 'worker', title: 'roadmap q1 2027?', who: 'Hugo', at: NOW - 5 * HOUR, workerId: 'w-hugo' }, body: 'I do not know.' };
    const both = matchExisting('whats the roadmap for q1 2027', [answer, file, ROADMAP], NOW);
    expect(both.map((h) => `${h.kind}:${h.who}`)).toEqual(['team:Product Team', 'worker:Hugo']);
  });

  it('passes weaker matches as hints only, and ignores the old and the unrelated', () => {
    const half: WorkCandidate = { hit: { kind: 'worker', title: 'Roadmap themes', who: 'Hugo', at: NOW - DAY, workerId: 'w-hugo' }, body: 'Themes for next year.' };
    const hits = matchExisting('whats the roadmap for q1 2027', [half], NOW);
    expect(hits).toEqual([expect.objectContaining({ title: 'Roadmap themes', weak: true })]);

    const old: WorkCandidate = { ...ROADMAP, hit: { ...ROADMAP.hit, at: NOW - 31 * DAY } };
    expect(matchExisting('whats the roadmap for q1 2027', [old], NOW)).toEqual([]);
    expect(matchExisting('where is the onboarding guide', [ROADMAP], NOW)).toEqual([]);
    // One content word is never enough to show.
    expect(matchExisting('where is the roadmap', [ROADMAP], NOW).every((h) => h.weak)).toBe(true);
    expect(matchExisting('what?', [ROADMAP], NOW)).toEqual([]);
  });

  it('reads a task\'s room with it, and leaves out a worker declining', () => {
    const task = { id: 't-9', kind: 'task', title: 'Exports MLP', at: NOW - DAY, status: 'delivered', body: 'The pack.', source: { kind: 'team', teamId: 'team-p', teamName: 'Product Team', taskId: 't-9' } } as unknown as LibraryItem;
    const room = [
      { id: 'a', speaker: { kind: 'you' as const }, text: 'what is code acme doing', at: NOW, exchange: 0 },
      { id: 'b', speaker: { kind: 'member' as const, workerId: 'w-h', name: 'Hugo' }, text: 'Code acme is the platform squad.', at: NOW, exchange: 0 },
      { id: 'c', speaker: { kind: 'coordinator' as const }, text: 'oops', at: NOW, exchange: 0, failed: true },
    ];
    const [c] = libraryCandidates([task], { room: () => room });
    expect(c.body).toBe("The pack.\n\nSince then, in the team's room:\n\nAsked: what is code acme doing\n\nHugo: Code acme is the platform squad.");
    expect(matchExisting('what is code acme doing', [c], NOW)[0].weak).toBeUndefined();
    expect(roomText([])).toBe('');

    const no = { id: 'ask:1', kind: 'answer', title: 'what is code acme doing', at: NOW, status: 'delivered', workerId: 'w-v', workerName: 'Vantage', body: 'This is internal product territory, outside my job as the competitive analyst.', source: { kind: 'ask' } } as unknown as LibraryItem;
    expect(libraryCandidates([no])).toEqual([]);
    expect(declined("That's not my remit.")).toBe(true);
    expect(declined('Code acme ships in March. I have no access to Jira, so the ticket count may lag.')).toBe(false);
  });

  it('shows the same question to the same team once, the newer', () => {
    const older: WorkCandidate = { ...ROADMAP, hit: { ...ROADMAP.hit, at: NOW - 2 * DAY, teamTaskId: 't-0' }, group: 'task:t-0' };
    const hits = matchExisting('whats the roadmap for q1 2027', [older, ROADMAP], NOW);
    expect(hits.map((h) => h.teamTaskId)).toEqual(['t-1']);
  });

  it('does not show words found only scattered through a body', () => {
    const pack: WorkCandidate = {
      hit: { kind: 'team', title: 'Exports MLP and how close are we', who: 'Product Team', at: NOW - DAY, teamTaskId: 't-2' },
      body: 'The code is merged to master. Open tickets: ACME-412 and ACME-413 are still red in CI.',
    };
    expect(matchExisting('what is code red doing', [pack], NOW).every((h) => h.weak)).toBe(true);
    // Side by side, as asked: a match.
    const said: WorkCandidate = { ...pack, body: 'Code red is the platform squad; it owns the sandbox.' };
    expect(matchExisting('what is code red doing', [said], NOW)[0].weak).toBeUndefined();
  });

  it('ranks the newer and the title match higher', () => {
    const words = contentWords('roadmap q1 2027');
    const inTitle = score(words, ROADMAP, NOW)!;
    const inBody = score(words, { hit: { ...ROADMAP.hit, title: 'Planning notes' }, body: ROADMAP.body }, NOW)!;
    const older = score(words, { ...ROADMAP, hit: { ...ROADMAP.hit, at: NOW - 20 * DAY } }, NOW)!;
    expect(inTitle.rank).toBeGreaterThan(inBody.rank);
    expect(inTitle.rank).toBeGreaterThan(older.rank);
    expect(inBody.coverage).toBe(1);
  });

  it('maps the Library: tasks to teams with a link, failed work dropped', () => {
    const base = { visibility: 'org', visibleTo: 'Everyone', links: [], deliveredTo: [], status: 'delivered' } as const;
    const items = [
      { ...base, id: 'task:t-1', kind: 'task', origin: { kind: 'task', teamId: 'team-product', teamName: 'Product Team', taskId: 't-1', taskTitle: 'x' }, workerId: '', workerName: 'Product Team', at: NOW, title: 'Q1 2027 roadmap', body: 'Three themes.', source: { kind: 'team', teamId: 'team-product', teamName: 'Product Team', taskId: 't-1' } },
      { ...base, id: 'ask:a-1', kind: 'answer', origin: { kind: 'errand', askId: 'a-1', workerId: 'w-hugo', workerName: 'Hugo', askedBy: 'Pat', question: 'q' }, workerId: 'w-hugo', workerName: 'Hugo', at: NOW, title: 'Churn this month', source: { kind: 'ask' } },
      { ...base, id: 'e-1', kind: 'event', status: 'failed', origin: { kind: 'event', triggerName: 't', workerId: 'w-hugo', workerName: 'Hugo' }, workerId: 'w-hugo', workerName: 'Hugo', at: NOW, title: 'Broken', source: { kind: 'ask' } },
    ] as unknown as LibraryItem[];
    const withUrl = libraryCandidates(items, { consoleUrl: 'https://overcli.acme.example/', taskStatus: () => 'waiting on your review' });
    expect(withUrl.map((c) => c.hit)).toEqual([
      { kind: 'team', title: 'Q1 2027 roadmap', who: 'Product Team', at: NOW, teamTaskId: 't-1', teamId: 'team-product', url: 'https://overcli.acme.example/#teamtask/t-1', status: 'waiting on your review' },
      { kind: 'worker', title: 'Churn this month', who: 'Hugo', at: NOW, workerId: 'w-hugo', url: 'https://overcli.acme.example/#read/ask%3Aa-1' },
    ]);
    // No public address (the desktop): no links.
    expect(libraryCandidates(items).every((c) => !c.hit.url)).toBe(true);
    expect(libraryCandidates([])).toEqual([]);
  });

  it('says when, and summarizes in a few sentences', () => {
    expect(whenText(NOW - HOUR, NOW)).toBe('today');
    expect(whenText(NOW - DAY, NOW)).toBe('yesterday');
    expect(whenText(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(summarize('# Roadmap\n\n- **Reporting** first.\n- Mobile next.\n- Then integrations. And more.')).toBe('Reporting first. Mobile next. Then integrations.');
    expect(summarize('')).toBe('');
  });
});
