// Cache behavior tests for the per-file parsers in stats.ts. The cache
// is module-level (intentionally — survives across IPC calls within a
// single app run), so the parser functions themselves are the API we
// can sensibly drive from tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClaudeFileCached, parseCodexFileCached } from './stats';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-cache-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const claudeAssistantLine = (overrides: { ts?: number; in?: number; out?: number } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: overrides.ts ?? 1700000000000,
    message: {
      model: 'claude-sonnet',
      usage: {
        input_tokens: overrides.in ?? 100,
        output_tokens: overrides.out ?? 200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [],
    },
  });

describe('parseClaudeFileCached', () => {
  it('returns parsed events on first call', () => {
    const file = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(file, claudeAssistantLine() + '\n');
    const events = parseClaudeFileCached(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inT: 100, outT: 200, model: 'claude-sonnet' });
  });

  it('returns the same array reference on a cache hit', () => {
    const file = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(file, claudeAssistantLine() + '\n');
    const a = parseClaudeFileCached(file);
    const b = parseClaudeFileCached(file);
    expect(b).toBe(a);
  });

  it('re-parses when the file mtime changes', () => {
    const file = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(file, claudeAssistantLine({ in: 1 }) + '\n');
    const a = parseClaudeFileCached(file);
    expect(a[0].inT).toBe(1);
    // Force a new mtime by writing again with a guaranteed-newer timestamp.
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(file, claudeAssistantLine({ in: 999 }) + '\n');
    fs.utimesSync(file, future, future);
    const b = parseClaudeFileCached(file);
    expect(b).not.toBe(a);
    expect(b[0].inT).toBe(999);
  });

  it('returns empty for a missing file (and caches nothing fatal)', () => {
    expect(parseClaudeFileCached(path.join(tmp, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('skips lines with all-zero usage (preserves existing semantics)', () => {
    const file = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(
      file,
      claudeAssistantLine({ in: 0, out: 0 }) + '\n' + claudeAssistantLine({ in: 5, out: 5 }) + '\n',
    );
    const events = parseClaudeFileCached(file);
    expect(events).toHaveLength(1);
    expect(events[0].inT).toBe(5);
  });

  it('tolerates malformed JSON lines without breaking subsequent parsing', () => {
    const file = path.join(tmp, 'sess.jsonl');
    fs.writeFileSync(file, 'not json\n' + claudeAssistantLine() + '\n');
    expect(parseClaudeFileCached(file)).toHaveLength(1);
  });
});

const codexSessionMeta = (cwd: string, ts = 1700000000000) =>
  JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { cwd } });

const codexTokenCount = (info: {
  in?: number;
  out?: number;
  cache?: number;
  ts?: number;
}) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: info.ts ?? 1700000000000,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: info.in ?? 100,
          output_tokens: info.out ?? 50,
          cached_input_tokens: info.cache ?? 0,
        },
      },
    },
  });

const codexAssistantMessage = (ts = 1700000000000) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: ts,
    payload: { type: 'message', role: 'assistant' },
  });

describe('parseCodexFileCached', () => {
  it('captures cwd, models, session totals, and event detail', () => {
    const file = path.join(tmp, 'roll.jsonl');
    fs.writeFileSync(
      file,
      [
        codexSessionMeta('/repo/a'),
        JSON.stringify({
          type: 'turn_context',
          timestamp: 1700000000001,
          payload: { model: 'gpt-5' },
        }),
        codexAssistantMessage(),
        codexTokenCount({ in: 100, out: 50 }),
      ].join('\n') + '\n',
    );
    const parsed = parseCodexFileCached(file);
    expect(parsed.cwd).toBe('/repo/a');
    expect(parsed.models).toEqual(['gpt-5']);
    expect(parsed.sessionTurns).toBe(1);
    expect(parsed.sessionIn).toBe(100);
    expect(parsed.sessionOut).toBe(50);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].kind).toBe('modelTurn');
    expect(parsed.events[1].kind).toBe('tokens');
  });

  it('returns the same parsed object reference on a cache hit', () => {
    const file = path.join(tmp, 'roll.jsonl');
    fs.writeFileSync(file, codexSessionMeta('/x') + '\n');
    const a = parseCodexFileCached(file);
    const b = parseCodexFileCached(file);
    expect(b).toBe(a);
  });

  it('re-parses on mtime change', () => {
    const file = path.join(tmp, 'roll.jsonl');
    fs.writeFileSync(file, codexSessionMeta('/repo/a') + '\n');
    const a = parseCodexFileCached(file);
    expect(a.cwd).toBe('/repo/a');
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(file, codexSessionMeta('/repo/b') + '\n');
    fs.utimesSync(file, future, future);
    const b = parseCodexFileCached(file);
    expect(b).not.toBe(a);
    expect(b.cwd).toBe('/repo/b');
  });

  it('returns an empty parse for a missing file', () => {
    const parsed = parseCodexFileCached(path.join(tmp, 'absent.jsonl'));
    expect(parsed.cwd).toBeNull();
    expect(parsed.events).toEqual([]);
  });

  it('attributes token_count to the most recent turn_context model', () => {
    const file = path.join(tmp, 'roll.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'turn_context',
          timestamp: 1,
          payload: { model: 'gpt-5' },
        }),
        codexTokenCount({ in: 10, out: 5 }),
        JSON.stringify({
          type: 'turn_context',
          timestamp: 2,
          payload: { model: 'gpt-5-mini' },
        }),
        codexTokenCount({ in: 1, out: 1 }),
      ].join('\n') + '\n',
    );
    const parsed = parseCodexFileCached(file);
    const tokenEvents = parsed.events.filter((e) => e.kind === 'tokens') as Array<{
      kind: 'tokens';
      model: string;
    }>;
    expect(tokenEvents.map((t) => t.model)).toEqual(['gpt-5', 'gpt-5-mini']);
  });
});
