import { describe, expect, it } from 'vitest';

import type { Flow } from '../../shared/flows/schema';
import type { RunSummary } from './runSummaryLog';
import { rankProvenFlows, renderProvenFlowsSection } from './provenFlows';

function flow(id: string, name: string, roles: string[]): Flow {
  return {
    id,
    name,
    steps: roles.map((role, i) => ({ id: `step-${i}`, role })),
  } as unknown as Flow;
}

function summary(flowId: string, completed: boolean, wallClockMs = 60_000): RunSummary {
  return {
    id: `${flowId}-${Math.random()}`,
    flowId,
    flowName: flowId,
    completed,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    wallClockMs,
    terminalAt: 0,
  } as unknown as RunSummary;
}

describe('rankProvenFlows', () => {
  it('excludes a flow with fewer than 3 runs', () => {
    const flows = [flow('a', 'A', ['planner'])];
    const summaries = [summary('a', true), summary('a', true)];

    expect(rankProvenFlows(flows, summaries)).toEqual([]);
  });

  it('excludes a flow below 60% completion', () => {
    const flows = [flow('a', 'A', ['planner'])];
    const summaries = [
      summary('a', true),
      summary('a', true),
      summary('a', false),
      summary('a', false),
      summary('a', false),
    ];

    expect(rankProvenFlows(flows, summaries)).toEqual([]);
  });

  it('excludes a summary whose flowId is not in the library', () => {
    const flows: Flow[] = [];
    const summaries = [summary('missing', true), summary('missing', true), summary('missing', true)];

    expect(rankProvenFlows(flows, summaries)).toEqual([]);
  });

  it('excludes a deep flow however heavily it is used', () => {
    // The most-run flow in a real library is often the longest one. Holding
    // an 11-step veteran up as "the shape that works" is the opposite of the
    // advice it sits next to.
    const deep = flow('deep', 'Deep', Array.from({ length: 8 }, () => 'implementer'));
    const lean = flow('lean', 'Lean', ['planner', 'implementer']);
    const summaries = [
      ...Array.from({ length: 90 }, () => summary('deep', true)),
      ...Array.from({ length: 3 }, () => summary('lean', true)),
    ];

    expect(rankProvenFlows([deep, lean], summaries).map((r) => r.flow.id)).toEqual(['lean']);
  });

  it('keeps a flow sitting exactly on the depth ceiling', () => {
    const atCeiling = flow('at', 'At', Array.from({ length: 7 }, () => 'implementer'));
    const summaries = Array.from({ length: 3 }, () => summary('at', true));

    expect(rankProvenFlows([atCeiling], summaries).map((r) => r.flow.id)).toEqual(['at']);
  });

  it('orders qualifying flows by run count descending', () => {
    const flows = [flow('a', 'A', ['planner']), flow('b', 'B', ['planner'])];
    const summaries = [
      ...Array.from({ length: 3 }, () => summary('a', true)),
      ...Array.from({ length: 5 }, () => summary('b', true)),
    ];

    const ranked = rankProvenFlows(flows, summaries);
    expect(ranked.map((r) => r.flow.id)).toEqual(['b', 'a']);
  });
});

describe('renderProvenFlowsSection', () => {
  it('returns an empty string when nothing qualifies', () => {
    expect(renderProvenFlowsSection([], [])).toBe('');
  });

  it('includes the flow name, step count, and role chain', () => {
    const flows = [flow('a', 'Ticket Fixer', ['planner', 'implementer', 'reviewer'])];
    const summaries = Array.from({ length: 4 }, () => summary('a', true));

    const section = renderProvenFlowsSection(flows, summaries);
    expect(section).toContain('Ticket Fixer');
    expect(section).toContain('3 steps');
    expect(section).toContain('planner → implementer → reviewer');
  });
});
