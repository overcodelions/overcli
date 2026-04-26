import { describe, expect, it } from 'vitest';
import { codexBackend, codexExecSnapshotText } from './codex';

function exec() {
  return codexBackend.makeParserState!({ codexMode: 'exec' });
}

describe('codexBackend.parseChunk — exec mode', () => {
  it('emits the compatibility-mode notice once', () => {
    const s = exec();
    const a = codexBackend.parseChunk!('hello', s);
    const noticeKinds = a.events.filter((e) => e.kind.type === 'systemNotice');
    expect(noticeKinds).toHaveLength(1);
    const b = codexBackend.parseChunk!(' world', s);
    expect(b.events.filter((e) => e.kind.type === 'systemNotice')).toHaveLength(0);
  });

  it('paints a single growing assistant snapshot with a stable id', () => {
    const s = exec();
    const a = codexBackend.parseChunk!('[2026-04-25T15:00:00] codex\nfirst', s);
    const b = codexBackend.parseChunk!(' more', s);
    const aAssistant = a.events.find((e) => e.kind.type === 'assistant')!;
    const bAssistant = b.events.find((e) => e.kind.type === 'assistant')!;
    expect(aAssistant.id).toBe(bAssistant.id);
    // Revisions monotonically increase.
    expect((bAssistant as any).revision).toBeGreaterThan((aAssistant as any).revision);
  });

  it('extracts sessionConfigured the first time the session id appears', () => {
    const s = exec();
    const a = codexBackend.parseChunk!('intro line\n', s);
    expect(a.sessionConfigured).toBeUndefined();
    const b = codexBackend.parseChunk!('session id: 0123abcd-ef00-4567\n', s);
    expect(b.sessionConfigured).toEqual({ sessionId: '0123abcd-ef00-4567' });
    // Second appearance should not re-emit.
    const c = codexBackend.parseChunk!('session id: 9999aaaa-bbbb-cccc\n', s);
    expect(c.sessionConfigured).toBeUndefined();
  });

  it('returns a Writing… liveActivity hint per chunk', () => {
    const s = exec();
    const out = codexBackend.parseChunk!('anything', s);
    expect(out.liveActivity).toBe('Writing…');
  });

  it('codexExecSnapshotText surfaces the latest extracted text', () => {
    const s = exec();
    codexBackend.parseChunk!(
      '[2026-04-25T15:00:00] codex\nthe answer is 42',
      s,
    );
    expect(codexExecSnapshotText(s)).toBe('the answer is 42');
  });
});

describe('codexBackend.parseChunk — non-exec modes', () => {
  it('proto returns no events (handled by separate transport)', () => {
    const s = codexBackend.makeParserState!({ codexMode: 'proto' });
    expect(codexBackend.parseChunk!('whatever', s)).toEqual({ events: [] });
  });

  it('app-server returns no events (handled by separate transport)', () => {
    const s = codexBackend.makeParserState!({ codexMode: 'app-server' });
    expect(codexBackend.parseChunk!('whatever', s)).toEqual({ events: [] });
  });
});
