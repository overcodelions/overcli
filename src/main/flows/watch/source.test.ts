import { describe, expect, it } from 'vitest';
import { getWatchSource, listWatchSources, parseWatchReport } from './source';
import './generic';

describe('parseWatchReport', () => {
  it('returns null when no block is present', () => {
    expect(parseWatchReport('just some chatter, no report')).toBeNull();
  });

  it('parses a clean answer report with answered ids', () => {
    const text = `did some checking
<watch_report>
{ "answered": 2, "answered_ids": ["10041", "10042"], "needs_work": false, "note": "Answered two tester questions." }
</watch_report>`;
    const r = parseWatchReport(text)!;
    expect(r.answered).toBe(2);
    expect(r.answeredIds).toEqual(['10041', '10042']);
    expect(r.needsWork).toBe(false);
    expect(r.note).toBe('Answered two tester questions.');
  });

  it('tolerates a ```json fence inside the block', () => {
    const text = `<watch_report>
\`\`\`json
{ "answered": 0, "needs_work": true, "note": "needs a fix" }
\`\`\`
</watch_report>`;
    const r = parseWatchReport(text)!;
    expect(r.needsWork).toBe(true);
    expect(r.answered).toBe(0);
  });

  it('treats malformed JSON as a safe no-op tick', () => {
    const r = parseWatchReport('<watch_report>{ not json </watch_report>')!;
    expect(r.answered).toBe(0);
    expect(r.needsWork).toBe(false);
  });

  it('drops empty / non-string answered ids', () => {
    const r = parseWatchReport(
      '<watch_report>{"answered":1,"answered_ids":["", 5, "c9"],"needs_work":false,"note":"ok"}</watch_report>',
    )!;
    expect(r.answeredIds).toEqual(['c9']);
  });

  it('clamps a negative/garbage answered count to zero', () => {
    const r = parseWatchReport(
      '<watch_report>{"answered":-3,"needs_work":false}</watch_report>',
    )!;
    expect(r.answered).toBe(0);
  });
});

describe('watch source registry', () => {
  it('registers the AI-defined source', () => {
    const ids = listWatchSources().map((s) => s.id);
    expect(ids).toContain('ai');
  });

  it('falls back to the AI-defined source for an unknown id', () => {
    expect(getWatchSource('does-not-exist').id).toBe('ai');
  });

  it('folds user instructions into the detect prompt', () => {
    const prompt = getWatchSource('ai').buildDetectPrompt({
      binding: 'PROJ-1',
      workSummary: 'fixed the login bug',
      instructions: 'answer tester questions only',
    });
    expect(prompt).toContain('answer tester questions only');
    expect(prompt).toContain('watch_report');
    expect(prompt.toLowerCase()).toContain('must not');
    // Detect tier must not post.
    expect(prompt.toLowerCase()).toContain('post nothing');
    expect(prompt).toContain('answer_needed');
  });

  it('tells the answer prompt to post a reply', () => {
    const prompt = getWatchSource('ai').buildAnswerPrompt({
      binding: 'PROJ-1',
      workSummary: 'fixed the login bug',
      detected: 'tester asked why X changed',
    });
    expect(prompt).toContain('tester asked why X changed');
    expect(prompt).toContain('watch_report');
    expect(prompt).toContain('answered');
  });
});

describe('parseWatchReport — detect fields', () => {
  it('parses answer_needed', () => {
    const r = parseWatchReport(
      '<watch_report>{"answer_needed":true,"needs_work":false,"note":"new question"}</watch_report>',
    )!;
    expect(r.answerNeeded).toBe(true);
    expect(r.needsWork).toBe(false);
  });
});
