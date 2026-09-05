// Reaching a long transcript's tail used to mean reading and JSON.parsing the
// whole file — 28MB read to keep a fraction of it, synchronously, on the main
// thread. `readTailLines` seeks instead. These tests pin what that seek must
// preserve: the newest turns, in order, whole, and never a line stitched
// together from the middle of the window it happened to land in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHistory } from './history';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/// A claude transcript of `count` user turns, each padded to roughly
/// `padBytes` so the file crosses whatever budget a test sets.
function writeClaudeTranscript(count: number, padBytes: number): {
  projectPath: string;
  sessionId: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-history-tail-'));
  dirs.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const projectPath = path.join(home, 'proj');
  fs.mkdirSync(projectPath, { recursive: true });
  // `claudeProjectSlug`: canonicalize (tmpdir is a symlink on macOS), then
  // '/', '.' and ' ' all become '-'.
  const slug = fs.realpathSync
    .native(projectPath)
    .replaceAll('/', '-')
    .replaceAll('.', '-')
    .replaceAll(' ', '-');
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'session-1';
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        message: { type: 'user', content: `turn ${i} ${'x'.repeat(padBytes)}` },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf-8');
  return { projectPath, sessionId };
}

function texts(events: ReturnType<typeof loadHistory>): string[] {
  return events
    .filter((e) => e.kind.type === 'localUser')
    .map((e) => (e.kind as { text: string }).text.split(' ').slice(0, 2).join(' '));
}

describe('history tail reads', () => {
  it('keeps the newest turns, in order, when the transcript exceeds the budget', () => {
    const { projectPath, sessionId } = writeClaudeTranscript(400, 2000);

    const events = loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 20_000 });

    const seen = texts(events);
    // The last turn is always present, and nothing older than the window.
    expect(seen[seen.length - 1]).toBe('turn 399');
    expect(seen.length).toBeLessThan(400);
    // Contiguous and ascending — a mid-line seek would corrupt or drop one.
    const nums = seen.map((t) => Number(t.split(' ')[1]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(nums[nums.length - 1] - nums[0]).toBe(nums.length - 1);
  });

  it('never emits a half-line: the window opens mid-record', () => {
    const { projectPath, sessionId } = writeClaudeTranscript(200, 1000);

    const events = loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 5_000 });

    // A partial first line would fail JSON.parse and be dropped silently; a
    // partial line that happened to parse would carry a truncated body. Every
    // surviving turn must be intact.
    for (const t of texts(events)) expect(t).toMatch(/^turn \d+$/);
    expect(texts(events).length).toBeGreaterThan(0);
  });

  it('says older turns are hidden, without inventing a count it cannot know', () => {
    const { projectPath, sessionId } = writeClaudeTranscript(400, 2000);

    const events = loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 20_000 });

    const notice = events[0];
    expect(notice.kind.type).toBe('systemNotice');
    const text = (notice.kind as { text: string }).text;
    expect(text).toContain('earlier turns are hidden');
    expect(text).not.toMatch(/\d+ earlier event/);
  });

  it('reads a transcript that fits whole, with no notice', () => {
    const { projectPath, sessionId } = writeClaudeTranscript(20, 100);

    const events = loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 6_000_000 });

    expect(texts(events)).toHaveLength(20);
    expect(texts(events)[0]).toBe('turn 0');
    expect(events.some((e) => e.kind.type === 'systemNotice')).toBe(false);
  });

  it('a bigger budget shows more of the same transcript', () => {
    const { projectPath, sessionId } = writeClaudeTranscript(400, 2000);

    const small = texts(loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 20_000 }));
    const large = texts(loadHistory({ backend: 'claude', projectPath, sessionId, budgetBytes: 200_000 }));

    expect(large.length).toBeGreaterThan(small.length);
    // Same tail either way — the extra budget is spent going further back.
    expect(large.slice(-small.length)).toEqual(small);
  });
});
