import { describe, expect, it } from 'vitest';
import type { StreamEvent, ToolUseBlock } from '@shared/types';
import {
  buildResponseModePrompt,
  detectConsolidationOpportunity,
} from './responseMode';

function event(id: string, kind: StreamEvent['kind']): StreamEvent {
  return { id, timestamp: 0, raw: '', revision: 0, kind };
}

function assistant(id: string, tools: ToolUseBlock[], isPartial = false): StreamEvent {
  return event(id, {
    type: 'assistant',
    info: { model: 'claude', text: '', thinking: [], toolUses: tools, isPartial },
  });
}

const tool = (id: string, name = 'Read'): ToolUseBlock => ({ id, name, inputJSON: '{}' });

describe('detectConsolidationOpportunity', () => {
  it('detects the same tool spread across three model rounds', () => {
    const events = [
      event('u', { type: 'localUser', text: 'inspect' }),
      assistant('a', [tool('1')]),
      assistant('b', [tool('2'), tool('3')]),
      assistant('c', [tool('4')]),
    ];
    expect(detectConsolidationOpportunity(events)).toEqual({
      toolName: 'Read',
      calls: 4,
      rounds: 3,
    });
  });

  it('does not call an already-batched round inefficient or count partial snapshots', () => {
    const events = [
      event('u', { type: 'localUser', text: 'inspect' }),
      assistant('partial', [tool('p')], true),
      assistant('a', [tool('1'), tool('2'), tool('3')]),
    ];
    expect(detectConsolidationOpportunity(events)).toBeNull();
  });
});

describe('buildResponseModePrompt', () => {
  it('leaves normal prompts byte-for-byte unchanged', () => {
    expect(buildResponseModePrompt('Do the work', 'normal', [])).toBe('Do the work');
  });

  it('makes concise output explicit without lowering reasoning', () => {
    const prompt = buildResponseModePrompt('Do the work', 'concise', []);
    expect(prompt).toContain('Preserve full reasoning quality');
    expect(prompt).not.toContain('Before calling tools');
    expect(prompt.endsWith('Do the work')).toBe(true);
  });

  it('adds fixed and measured consolidation guidance in efficient mode', () => {
    const prior = [
      event('u', { type: 'localUser', text: 'inspect' }),
      assistant('a', [tool('1', 'Grep')]),
      assistant('b', [tool('2', 'Grep')]),
      assistant('c', [tool('3', 'Grep')]),
    ];
    const prompt = buildResponseModePrompt('Continue', 'efficient', prior);
    expect(prompt).toContain('Before calling tools');
    expect(prompt).toContain('Grep in 3 separate model rounds');
  });

  it('adds a speed-first directive for Turbo and Warp', () => {
    for (const mode of ['turbo', 'warp'] as const) {
      const prompt = buildResponseModePrompt('Continue', 'efficient', [], mode);
      expect(prompt).toContain('Prioritize response latency');
      expect(prompt).toContain('Do not skip required checks');
    }
  });
});
