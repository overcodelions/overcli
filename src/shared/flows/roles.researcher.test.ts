import { describe, expect, it } from 'vitest';

import { resolveSystemPrompt } from './roles';

describe('resolveSystemPrompt — researcher prompt', () => {
  it('includes the new fact-only guardrails for researchers', () => {
    const prompt = resolveSystemPrompt({ role: 'researcher', outputName: 'brief.md' });

    expect(prompt).toContain('STRICTLY FORBIDDEN');
    expect(prompt).toContain('Litmus test before you finish');
    expect(prompt).toContain('Open questions or ambiguities');
    expect(prompt).toContain('<output name="brief.md">');
  });
});
