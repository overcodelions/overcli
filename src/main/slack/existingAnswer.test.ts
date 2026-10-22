import { describe, expect, it } from 'vitest';
import { answerPrompt, readAnswer, withoutPaths, type AnswerSource } from './existingAnswer';

const PLAN: AnswerSource = { label: 'Product Team\'s task "whats next on the roadmap" (2 days ago)', who: 'Product Team', body: 'Q1 2027: reporting first, then the mobile app.' };
const KNOWS: AnswerSource = { label: 'What Product Team knows', who: 'Product Team', body: 'Jira projects: ACME (Code Acme), the platform squad.' };

describe('answering from existing work', () => {
  it('numbers the sources for the model', () => {
    const p = answerPrompt('whats next on the roadmap', [PLAN, KNOWS]);
    expect(p).toContain('Question:\nwhats next on the roadmap');
    expect(p).toContain('[1] Product Team\'s task "whats next on the roadmap" (2 days ago)\nQ1 2027');
    expect(p).toContain('[2] What Product Team knows\nJira projects');
  });

  it('never hands Slack a path on the server', () => {
    expect(withoutPaths('It is Hugo\'s report: `~/.overcli/coordinators/25259f09-…/roadmap/acme-roadmap-2026-10-19.html`. A copy is at `Q1_ROADMAP_REPORT.html`.'))
      .toBe('It is Hugo\'s report: _acme-roadmap-2026-10-19.html_. A copy is at `Q1_ROADMAP_REPORT.html`.');
    expect(withoutPaths('Notes (`ranking-journal.md`) are in `Workers/Hugo/2026-10-19 Roadmap report/`.')).toBe('Notes (`ranking-journal.md`) are in.');
    expect(withoutPaths('See https://acme.productboard.com/roadmap/q1 for dates.')).toBe('See https://acme.productboard.com/roadmap/q1 for dates.');
  });

  it('reads the answer and the sources it used, or none', () => {
    expect(readAnswer('Reporting ships first, then the mobile app.\n\nSources: 2, 1', [PLAN, KNOWS])).toEqual({ text: 'Reporting ships first, then the mobile app.', used: [KNOWS, PLAN] });
    // No sources line: the first.
    expect(readAnswer('Reporting first.', [PLAN, KNOWS])?.used).toEqual([PLAN]);
    expect(readAnswer('NONE', [PLAN])).toBeNull();
    // A preface and a rule around it: dropped.
    expect(readAnswer("I've written the answer into the plan file. Here's the reply for Slack:\n\n---\n\nReporting first.\n\n---\nSources: 1", [PLAN])).toEqual({ text: 'Reporting first.', used: [PLAN] });
    expect(readAnswer('  none. ', [PLAN])).toBeNull();
  });
});
