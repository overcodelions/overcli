import { describe, expect, it } from 'vitest';
import { collapsePartialAssistants, extractCodexExecSnapshot } from './streamSnapshot';
import type { StreamEvent } from '../shared/types';

function partial(id: string, text: string): StreamEvent {
  return {
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: 'm', text, toolUses: [], thinking: [], isPartial: true },
    },
  };
}

function final(id: string, text: string): StreamEvent {
  return {
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: 'm', text, toolUses: [], thinking: [] },
    },
  };
}

function notice(id: string, text: string): StreamEvent {
  return { id, timestamp: 0, raw: '', revision: 0, kind: { type: 'systemNotice', text } };
}

describe('collapsePartialAssistants — extra coverage', () => {
  it('returns the same array reference when nothing is partial', () => {
    const input = [final('a', 'hi'), notice('n', 'note')];
    expect(collapsePartialAssistants(input)).toBe(input);
  });

  it('keeps only the latest partial per id and preserves order', () => {
    const input = [
      partial('a', 'a1'),
      partial('a', 'a2'),
      notice('n', 'in between'),
      partial('a', 'a3'),
    ];
    const out = collapsePartialAssistants(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[2]);
    expect(out[1]).toBe(input[3]);
  });

  it('handles multiple distinct partial ids independently', () => {
    const input = [partial('a', 'a1'), partial('b', 'b1'), partial('a', 'a2'), partial('b', 'b2')];
    const out = collapsePartialAssistants(input);
    expect(out).toHaveLength(2);
    expect(out.map((e) => (e.kind as any).info.text)).toEqual(['a2', 'b2']);
  });

  it('lets non-partial assistants pass through alongside partials', () => {
    const input = [partial('a', 'a1'), partial('a', 'a2'), final('b', 'done')];
    const out = collapsePartialAssistants(input);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(input[2]);
  });
});

describe('extractCodexExecSnapshot — extra coverage', () => {
  it('returns empty for blank-only input', () => {
    expect(extractCodexExecSnapshot('   \n\n  ')).toEqual({ text: '', thinking: '' });
  });

  it('falls back to raw text when no recognizable section markers exist', () => {
    expect(extractCodexExecSnapshot('plain log line')).toEqual({
      text: 'plain log line',
      thinking: '',
    });
  });

  it('parses the timestamped block format', () => {
    const raw = [
      '[2026-04-25T15:00:00] thinking',
      'mulling it over',
      '[2026-04-25T15:00:01] codex',
      'here is the answer',
    ].join('\n');
    expect(extractCodexExecSnapshot(raw)).toEqual({
      text: 'here is the answer',
      thinking: 'mulling it over',
    });
  });

  it('joins multiple codex blocks with a blank line', () => {
    const raw = [
      '[2026-04-25T15:00:00] codex',
      'part one.',
      '[2026-04-25T15:00:01] codex',
      'part two.',
    ].join('\n');
    expect(extractCodexExecSnapshot(raw).text).toBe('part one.\n\npart two.');
  });

  it('ignores empty bodies between markers', () => {
    const raw = ['[2026-04-25T15:00:00] codex', '', '[2026-04-25T15:00:01] codex', 'real'].join('\n');
    expect(extractCodexExecSnapshot(raw).text).toBe('real');
  });

  it('parses the plain section format as a fallback', () => {
    const raw = ['thinking', 'planning the approach', '', 'codex', 'final answer here'].join('\n');
    const snap = extractCodexExecSnapshot(raw);
    expect(snap.thinking).toContain('planning the approach');
    expect(snap.text).toContain('final answer here');
  });
});
