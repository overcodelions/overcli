import { describe, expect, it } from 'vitest';

import type { FlowRolePreset } from './schema';
import { artifactInstruction, resolveSystemPrompt } from './roles';

describe('resolveSystemPrompt', () => {
  it.each([
    ['planner', 'PLANNER'],
    ['implementer', 'IMPLEMENTER'],
    ['reviewer', 'REVIEWER'],
    ['test-writer', 'TEST-WRITER'],
    ['researcher', 'RESEARCHER'],
    ['shipper', 'SHIPPER'],
  ] as Array<[Exclude<FlowRolePreset, 'custom'>, string]>)(
    'includes the %s preset title and artifact contract',
    (role, title) => {
      const prompt = resolveSystemPrompt({ role, outputName: 'foo.md' });
      expect(prompt).toContain(title);
      expect(prompt).toContain('<output name="foo.md">');
    },
  );

  it('uses a non-empty custom override and includes the artifact contract', () => {
    const prompt = resolveSystemPrompt({
      role: 'custom',
      override: 'Write the final answer as terse release notes.',
      outputName: 'foo.md',
    });
    expect(prompt).toContain('terse release notes');
    expect(prompt).toContain('<output name="foo.md">');
  });

  it.each([undefined, '', '   '])(
    'uses a placeholder for an empty custom override',
    override => {
      const prompt = resolveSystemPrompt({
        role: 'custom',
        override,
        outputName: 'foo.md',
      });
      expect(prompt).toContain('(no system prompt provided)');
    },
  );
});

describe('artifactInstruction', () => {
  it('includes the named output block marker', () => {
    expect(artifactInstruction('plan.md')).toContain('<output name="plan.md">');
    expect(artifactInstruction('plan.md')).toContain('</output>');
  });

  it('warns models against nesting output tags', () => {
    expect(artifactInstruction('diff')).toContain('Do NOT nest');
  });

  // A read-only step ("investigate, do not write anything") reads the block as
  // a write it was just forbidden to make, ends its turn without one, and the
  // run pauses on "produced no <output>". Saying the block is chat text —
  // not a file — settles the conflict in the contract itself.
  it('tells a read-only step the block is not a file it is forbidden to write', () => {
    const instruction = artifactInstruction('findings.md');
    expect(instruction).toContain('It is not a file');
    expect(instruction).toContain('read-only step still emits its findings');
  });
});
