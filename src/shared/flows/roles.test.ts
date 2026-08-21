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

  it('is byte-identical whether allowFileRef is omitted or explicitly false', () => {
    const withoutArg = resolveSystemPrompt({ role: 'planner', outputName: 'foo.md' });
    const explicitFalse = resolveSystemPrompt({
      role: 'planner',
      outputName: 'foo.md',
      allowFileRef: false,
    });
    expect(explicitFalse).toBe(withoutArg);
  });

  it('offers the pointer form when allowFileRef is true', () => {
    const prompt = resolveSystemPrompt({
      role: 'planner',
      outputName: 'foo.md',
      allowFileRef: true,
    });
    expect(prompt).toContain('<output name="foo.md" file="relative/path/to/the/file" />');
  });
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

  it('is byte-identical whether allowFileRef is omitted or explicitly false', () => {
    expect(artifactInstruction('plan.md')).toBe(artifactInstruction('plan.md', false));
  });

  it('does not mention the pointer form when allowFileRef is false', () => {
    expect(artifactInstruction('plan.md', false)).not.toContain('file=');
  });

  it('offers the pointer form when allowFileRef is true', () => {
    const instruction = artifactInstruction('plan.md', true);
    expect(instruction).toContain('CHEAPER ALTERNATIVE');
    expect(instruction).toContain('<output name="plan.md" file="relative/path/to/the/file" />');
  });

  it('does not contradict the pointer form with a mandatory inline-tag rule', () => {
    // "Rules:" (unqualified) reads as "you MUST do this", which contradicts
    // the pointer form's "point at the file instead of the block" offer
    // immediately above it. Scoping the heading to the inline form keeps
    // both true at once.
    const instruction = artifactInstruction('plan.md', true);
    expect(instruction).toContain('Rules for the inline block form:');
    expect(instruction).not.toMatch(/\nRules:\n/);
  });
});
