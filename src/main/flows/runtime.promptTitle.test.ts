import { describe, it, expect } from 'vitest';
import { buildStepPromptTitle } from './runtime';

const step = { id: 'build', role: 'implementer' } as never;

function run(userPrompt: string, name = 'Ticket to PR') {
  return { flowSnapshot: { id: 'ticket-to-pr', name }, userPrompt } as never;
}

describe('buildStepPromptTitle', () => {
  it('names the flow, the step and the gist of the request', () => {
    expect(buildStepPromptTitle(run('Fix the breadcrumbs on pipe edit.'), step)).toBe(
      'Overcli · Ticket to PR · build (implementer) — Fix the breadcrumbs on pipe edit.\n\n',
    );
  });

  it('leads the prompt so a CLI that titles threads from the first line sees it', () => {
    expect(buildStepPromptTitle(run('Anything'), step).split('\n')[0]).toMatch(/^Overcli · /);
  });

  it('takes the first meaningful line and strips markdown syntax', () => {
    const title = buildStepPromptTitle(run('\n\n## RED-6936 breadcrumbs\n\nmore detail here'), step);
    expect(title).toContain('— RED-6936 breadcrumbs');
    expect(title).not.toContain('#');
    expect(title).not.toContain('more detail');
  });

  it('truncates a long request instead of dumping a paragraph into the title', () => {
    const title = buildStepPromptTitle(run('x'.repeat(300)), step).trim();
    expect(title.length).toBeLessThan(120);
    expect(title.endsWith('…')).toBe(true);
  });

  it('omits the gist when there is no user prompt', () => {
    expect(buildStepPromptTitle(run(''), step)).toBe(
      'Overcli · Ticket to PR · build (implementer)\n\n',
    );
  });

  it('falls back to the flow id when the flow has no name', () => {
    expect(buildStepPromptTitle(run('hi', ''), step)).toContain('· ticket-to-pr ·');
  });
});
