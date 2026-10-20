import { describe, expect, it } from 'vitest';
import { firstJsonObject, imageFromDataUrl, processImagePrompt, readProcessDraft, suggestDoer, MAX_DRAFT_STAGES } from './processDraft';

const TEAMS = [
  { id: 't-legal', name: 'Acme Legal', purpose: 'Contract and legal review', members: [{ role: 'Legal counsel' }] },
  { id: 't-design', name: 'Product Design', purpose: 'Design and prototypes', members: [{ role: 'Product designer' }] },
];
const WORKERS = [{ id: 'w-notes', name: 'Notetaker', tagline: 'Writes release notes' }];
const PEOPLE = [{ name: 'Pat', slackUserId: 'U0ACMEPAT' }, { name: 'Sam' }];
const INPUT = { teams: TEAMS, workers: WORKERS, people: PEOPLE };

const reply = (o: unknown) => `Here is the process.\n${JSON.stringify(o)}\nHope that helps {not json}`;

describe('firstJsonObject', () => {
  it('reads the first whole object, braces inside strings and all', () => {
    expect(firstJsonObject('noise {"a": "x } y", "b": {"c": 1}} trailing {"d": 2}')).toEqual({ a: 'x } y', b: { c: 1 } });
  });
  it('skips a broken object and finds a later one', () => {
    expect(firstJsonObject('{nope} then {"ok": true}')).toEqual({ ok: true });
  });
  it('is null with no object', () => {
    expect(firstJsonObject('no json here')).toBeNull();
  });
});

describe('readProcessDraft', () => {
  it('turns stages into a draft: kinds, timing, send back and doers', () => {
    const res = readProcessDraft(
      reply({
        name: 'Contract approval',
        about: 'A contract request becomes a signed contract.',
        stages: [
          { name: 'Draft contract', kind: 'team', ask: 'Write the first draft.', role: 'Sales ops', team: null },
          { name: 'Legal review', kind: 'team', ask: 'Check the terms.', role: 'Legal reviewer', team: null },
          { name: 'Approved?', kind: 'decision', ask: 'Are the terms acceptable?', deciders: [1, 9], sendBackTo: 1 },
          { name: 'Design the pack', kind: 'team', team: 2, delayDays: 3.4 },
          { name: 'Weekly check-in', kind: 'worker', worker: 1, repeat: { everyDays: 7, times: 4 } },
        ],
        notes: ['The signing step is drawn in parallel with billing.'],
      }),
      INPUT,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.name).toBe('Contract approval');
    expect(res.draft.about).toBe('A contract request becomes a signed contract.');
    const [draft, legal, approve, design, check] = res.draft.stages;
    expect(draft).toEqual({ id: 'd1', name: 'Draft contract', kind: 'team', ask: 'Write the first draft.', suggestedRole: 'Sales ops' });
    // Not picked by the model, but the role clearly fits a team.
    expect(legal.teamId).toBe('t-legal');
    expect(legal.suggestedRole).toBeUndefined();
    expect(approve).toMatchObject({ kind: 'people', approvers: [{ name: 'Pat', slackUserId: 'U0ACMEPAT' }], sendBackTo: 'd1' });
    expect(design).toMatchObject({ teamId: 't-design', delayDays: 3 });
    expect(check).toMatchObject({ kind: 'worker', workerId: 'w-notes', repeat: { everyDays: 7, times: 4 } });
    expect(res.notes).toEqual(['The signing step is drawn in parallel with billing.']);
  });

  it('keeps send back to an earlier working stage, and says what it dropped', () => {
    const res = readProcessDraft(
      reply({
        name: 'QA loop',
        stages: [
          { name: 'Build', kind: 'team' },
          { name: 'Test', kind: 'team', sendBackTo: 1 },
          { name: 'Go?', kind: 'people', sendBackTo: 4 },
          { name: 'Ship it', kind: 'people', sendBackTo: 3 },
        ],
      }),
      INPUT,
    );
    if (!res.ok) throw new Error(res.error);
    const [, test, go, ship] = res.draft.stages;
    expect(test.sendBackTo).toBeUndefined();
    expect(go.sendBackTo).toBeUndefined();
    // Back to a decision lands on the working stage before it.
    expect(ship.sendBackTo).toBe('d2');
    expect(res.notes.join(' ')).toMatch(/Test sends work back to Build/);
    expect(res.notes.join(' ')).toMatch(/points forward/);
  });

  it('caps stages and lengths, ignores bad picks and drops timing on decisions', () => {
    const stages = Array.from({ length: 15 }, (_, i) => ({ name: `Step ${i + 1} ${'x'.repeat(100)}`, kind: i === 0 ? 'people' : 'team', team: 99, worker: 'abc', delayDays: i === 0 ? 5 : -2, repeat: { everyDays: 500, times: 1 } }));
    const res = readProcessDraft(reply({ name: 'n'.repeat(300), stages }), INPUT);
    if (!res.ok) throw new Error(res.error);
    expect(res.draft.stages).toHaveLength(MAX_DRAFT_STAGES);
    expect(res.draft.name.length).toBeLessThanOrEqual(120);
    expect(res.draft.stages.every((s) => s.name.length <= 60)).toBe(true);
    expect(res.draft.stages[0]).toMatchObject({ kind: 'people', approvers: [] });
    expect(res.draft.stages[0].delayDays).toBeUndefined();
    expect(res.draft.stages[1].teamId).toBeUndefined();
    expect(res.draft.stages[1].delayDays).toBeUndefined();
    expect(res.draft.stages[1].repeat).toBeUndefined();
    expect(res.notes.join(' ')).toMatch(/15 steps; the first 12/);
  });

  it('fails plainly on no JSON or no stages', () => {
    expect(readProcessDraft('I cannot see a diagram.', INPUT)).toEqual({ ok: false, error: expect.stringMatching(/couldn’t be read/) });
    expect(readProcessDraft(reply({ name: 'x', stages: [], notes: ['This is a photo of a cat, not a process.'] }), INPUT)).toEqual({ ok: false, error: 'This is a photo of a cat, not a process.' });
  });
});

describe('suggestDoer', () => {
  it('matches a team on the stage and its role, and never a weak guess', () => {
    expect(suggestDoer({ kind: 'team', name: 'Legal review', role: 'Legal reviewer' }, TEAMS, WORKERS)).toEqual({ teamId: 't-legal' });
    expect(suggestDoer({ kind: 'team', name: 'Pricing', role: 'Finance' }, TEAMS, WORKERS)).toEqual({});
    expect(suggestDoer({ kind: 'people', name: 'Legal approval' }, TEAMS, WORKERS)).toEqual({});
  });
  it('matches a worker on its name and tagline', () => {
    expect(suggestDoer({ kind: 'worker', name: 'Release notes', role: 'Release writer' }, TEAMS, WORKERS)).toEqual({ workerId: 'w-notes' });
  });
});

describe('imageFromDataUrl', () => {
  const png = 'data:image/png;base64,' + Buffer.alloc(200, 1).toString('base64');
  it('takes a PNG, JPEG, WebP or GIF data URL', () => {
    const res = imageFromDataUrl(png);
    expect(res).toMatchObject({ ok: true, image: { mimeType: 'image/png', size: 200 } });
    expect(imageFromDataUrl(png.replace('image/png', 'image/jpg'))).toMatchObject({ ok: true, image: { mimeType: 'image/jpeg' } });
  });
  it('refuses other types, junk and pictures over 5 MB', () => {
    expect(imageFromDataUrl('data:image/svg+xml;base64,PHN2Zz4=').ok).toBe(false);
    expect(imageFromDataUrl('not a picture').ok).toBe(false);
    expect(imageFromDataUrl(42).ok).toBe(false);
    const big = 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 10).toString('base64');
    expect(imageFromDataUrl(big)).toEqual({ ok: false, error: expect.stringMatching(/under 5 MB/) });
  });
});

describe('processImagePrompt', () => {
  it('numbers the teams, workers and people and carries the note', () => {
    const p = processImagePrompt({ ...INPUT, note: 'Use Product Design for design.' });
    expect(p).toMatch(/note: Use Product Design for design\./);
    expect(p).toMatch(/1\. Acme Legal — Contract and legal review \(roles: Legal counsel\)/);
    expect(p).toMatch(/Workers:\n1\. Notetaker/);
    expect(p).toMatch(/People:\n1\. Pat\n2\. Sam/);
  });
});
