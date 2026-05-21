import { describe, expect, it } from 'vitest';

import {
  isFlowStepTurn,
  parseFlowSections,
  parseFlowStepContent,
} from './flowStepSections';

describe('parseFlowSections', () => {
  it('splits a full step body into ordered sections', () => {
    const body = [
      '<!--flow:header-->',
      '### Step: `tests`',
      '<!--flow:instructions-->',
      'You are the TEST-WRITER step.',
      '<!--flow:inputs-->',
      '#### diff',
      '```diff\n+ added\n```',
    ].join('\n\n');
    const sections = parseFlowSections(body);
    expect(sections.map((s) => s.kind)).toEqual(['header', 'instructions', 'inputs']);
    expect(sections[0].content).toBe('### Step: `tests`');
    expect(sections[1].content).toBe('You are the TEST-WRITER step.');
    expect(sections[2].content).toContain('#### diff');
  });

  it('returns an empty array for legacy bodies without markers', () => {
    expect(parseFlowSections('### Step: `plan`\n\nplain markdown')).toEqual([]);
  });

  it('is reusable across calls (regex lastIndex reset)', () => {
    const body = '<!--flow:header-->\nh';
    expect(parseFlowSections(body)).toHaveLength(1);
    expect(parseFlowSections(body)).toHaveLength(1);
  });
});

describe('parseFlowStepContent — live (markered)', () => {
  const live = [
    '<!--flow-->',
    '<!--flow:header-->',
    '### Step: `tests`  ·  test-writer',
    '<!--flow:instructions-->',
    'You are the TEST-WRITER step of a multi-stage automated flow.',
    '<!--flow:inputs-->',
    '#### diff\n\n```diff\n+ added\n```',
  ].join('\n\n');

  it('extracts header, instructions, and inputs', () => {
    const c = parseFlowStepContent(live)!;
    expect(c.headerMarkdown).toContain('### Step: `tests`');
    expect(c.title).toBeNull();
    expect(c.instructions).toContain('TEST-WRITER step');
    expect(c.inputsMarkdown).toContain('#### diff');
  });

  it('drops a "_no inputs_" placeholder', () => {
    const c = parseFlowStepContent(
      '<!--flow-->\n\n<!--flow:header-->\n\n### Step\n\n<!--flow:inputs-->\n\n_no inputs_',
    )!;
    expect(c.inputsMarkdown).toBeNull();
  });
});

describe('parseFlowStepContent — reloaded (raw prompt)', () => {
  // Shaped exactly like buildStepPrompt's output.
  const raw = [
    'You are the REVIEWER step of a multi-stage automated flow.',
    '',
    'Your job: decide whether the diff satisfies the plan.',
    '',
    'IMPORTANT — output contract:',
    'Wrap your final deliverable for this step in EXACTLY ONE <output name="review.md"> … </output> block.',
    '',
    '---',
    '',
    'INPUTS:',
    '',
    '<input name="plan.md">\n# Plan: do the thing\n</input>',
    '',
    '<input name="diff">\n+ added line\n</input>',
    '',
    '---',
    '',
    'Proceed with your task now. Remember to wrap your final deliverable in <output name="review.md">…</output>.',
  ].join('\n');

  it('is recognized as a flow step turn', () => {
    expect(isFlowStepTurn(raw)).toBe(true);
    expect(isFlowStepTurn('just a normal user message')).toBe(false);
  });

  it('derives a title from the role line', () => {
    const c = parseFlowStepContent(raw)!;
    expect(c.title).toBe('reviewer step');
    expect(c.headerMarkdown).toBeNull();
  });

  it('strips the output contract from the instructions', () => {
    const c = parseFlowStepContent(raw)!;
    expect(c.instructions).toContain('decide whether the diff satisfies the plan');
    expect(c.instructions).not.toContain('output contract');
    expect(c.instructions).not.toContain('Wrap your final deliverable');
  });

  it('renders inputs as markdown with the diff fenced', () => {
    const c = parseFlowStepContent(raw)!;
    expect(c.inputsMarkdown).toContain('#### plan.md');
    expect(c.inputsMarkdown).toContain('# Plan: do the thing');
    expect(c.inputsMarkdown).toContain('#### diff');
    expect(c.inputsMarkdown).toContain('```diff\n+ added line\n```');
  });

  it('notes attached (large) inputs instead of inlining a path', () => {
    const withAttached =
      'You are the BUILD step of a multi-stage automated flow.\n\n' +
      'IMPORTANT — output contract:\nx\n\n---\n\nINPUTS:\n\n' +
      '<input name="diff" attached="/tmp/x" size="9999">\nThis input is too large to inline.\n</input>' +
      '\n\n---\n\nProceed with your task now. Remember to wrap your final deliverable in <output name="diff">…</output>.';
    const c = parseFlowStepContent(withAttached)!;
    expect(c.inputsMarkdown).toContain('_(attached file: /tmp/x)_');
  });

  it('returns null for non-flow text', () => {
    expect(parseFlowStepContent('hello there')).toBeNull();
  });
});
