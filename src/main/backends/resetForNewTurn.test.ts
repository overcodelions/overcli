// Regression coverage for the mid-turn parser-state reset.
//
// Background: the mid-turn reset fires when a user sends a follow-up
// while a previous subprocess is still alive. Claude reuses its
// long-lived subprocess and must preserve in-flight stream state
// across the boundary; codex / gemini accumulate per-turn state that
// must be dropped or the next turn's content bleeds into the previous
// bubble.
//
// The bug this guards against: claude's inFlightEventId being wiped
// mid-stream, which orphans subsequent stdout chunks into a duplicate
// assistant bubble (rendered separately because the renderer keys on id).

import { describe, expect, it } from 'vitest';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { geminiBackend } from './gemini';

describe('claudeBackend.resetForNewTurn', () => {
  it('is intentionally undefined — claude self-manages via message_start/stop', () => {
    // If you ever add this method to the claude spec, also remove the
    // streaming-bug regression at the bottom of this file or it will
    // start failing for the right reason.
    expect(claudeBackend.resetForNewTurn).toBeUndefined();
  });

  it('streaming an assistant message survives the runner-side reset call', () => {
    // Simulate the runner calling spec.resetForNewTurn?.(state) when a
    // follow-up arrives mid-stream. With claude omitting the method
    // entirely, the optional-chain is a no-op and state is preserved.
    const state = claudeBackend.makeParserState!() as { buffer: string; inner: { inFlightEventId: unknown } };
    // Push a message_start so inFlightEventId is set.
    const start = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-1', model: 'claude' } },
    });
    claudeBackend.parseChunk!(start + '\n', state);
    const idBefore = state.inner.inFlightEventId;
    expect(idBefore).toBeTruthy();

    // The runner does this exact call on every new send.
    claudeBackend.resetForNewTurn?.(state);

    // The id MUST persist — that's what keeps trailing chunks of the
    // in-flight message routed to the same renderer bubble.
    expect(state.inner.inFlightEventId).toBe(idBefore);
  });
});

describe('codexBackend.resetForNewTurn', () => {
  it('drops the accumulator + snapshot id', () => {
    const state = codexBackend.makeParserState!({ codexMode: 'exec' }) as any;
    codexBackend.parseChunk!('hello world', state);
    expect(state.accumulator).toBe('hello world');
    expect(state.eventId).toBeTruthy();
    expect(state.revision).toBeGreaterThan(0);

    codexBackend.resetForNewTurn!(state);

    expect(state.accumulator).toBe('');
    expect(state.eventId).toBeUndefined();
    expect(state.revision).toBe(0);
  });

  it('preserves subprocess-lifetime flags (mode, session, notice)', () => {
    const state = codexBackend.makeParserState!({ codexMode: 'exec' }) as any;
    codexBackend.parseChunk!('session id: abcd1234-5678-9012\n', state);
    expect(state.mode).toBe('exec');
    expect(state.sessionEmitted).toBe(true);
    expect(state.noticeEmitted).toBe(true);

    codexBackend.resetForNewTurn!(state);

    // These should NOT reset — the compatibility-mode notice is
    // shown once per subprocess, not once per turn, and the session
    // id once observed should not be re-surfaced.
    expect(state.mode).toBe('exec');
    expect(state.sessionEmitted).toBe(true);
    expect(state.noticeEmitted).toBe(true);
  });

  it('a second turn paints into a fresh bubble after reset', () => {
    const state = codexBackend.makeParserState!({ codexMode: 'exec' }) as any;
    const t1 = codexBackend.parseChunk!('[2026-04-25T15:00:00] codex\nturn one', state);
    const t1Assistant = t1.events.find((e) => e.kind.type === 'assistant')!;

    codexBackend.resetForNewTurn!(state);

    const t2 = codexBackend.parseChunk!('[2026-04-25T15:01:00] codex\nturn two', state);
    const t2Assistant = t2.events.find((e) => e.kind.type === 'assistant')!;

    expect(t1Assistant.id).not.toBe(t2Assistant.id);
    expect((t2Assistant.kind as any).info.text).toBe('turn two');
  });
});

describe('geminiBackend.resetForNewTurn', () => {
  it('drops the coalesce fields + line buffer', () => {
    const state = geminiBackend.makeParserState!() as any;
    state.buffer = 'partial line';
    state.assistantEventId = 'old-id';
    state.assistantText = 'previous turn';
    state.assistantToolUses = [{ id: 't1', name: 'X', inputJSON: '{}' }];
    state.assistantNeedsSplit = true;

    geminiBackend.resetForNewTurn!(state);

    expect(state.buffer).toBe('');
    expect(state.assistantEventId).toBeUndefined();
    expect(state.assistantText).toBe('');
    expect(state.assistantToolUses).toEqual([]);
    expect(state.assistantNeedsSplit).toBe(false);
  });
});

describe('safety: resetForNewTurn handles missing state', () => {
  it('codex resetForNewTurn is a no-op on undefined state', () => {
    expect(() => codexBackend.resetForNewTurn!(undefined)).not.toThrow();
  });

  it('gemini resetForNewTurn is a no-op on undefined state', () => {
    expect(() => geminiBackend.resetForNewTurn!(undefined)).not.toThrow();
  });
});
