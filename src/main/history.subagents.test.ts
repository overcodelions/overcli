// Claude Code writes each subagent's transcript to its own file beside the
// session, with a `.meta.json` naming the Agent tool_use that launched it.
// Reopening a conversation has to read those, or every subagent card opens
// onto an empty drawer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadClaudeSubagentHistory, loadHistory } from './history';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function assistant(id: string, content: unknown[], extra: Record<string, unknown> = {}): string {
  return line({
    type: 'assistant',
    timestamp: '2026-10-15T10:00:00Z',
    message: { id, role: 'assistant', model: 'claude-sonnet-5', content },
    ...extra,
  });
}

function setup(): { home: string; projectPath: string; sessionDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-history-sub-'));
  dirs.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const projectPath = path.join(home, 'proj');
  fs.mkdirSync(projectPath, { recursive: true });
  const slug = fs.realpathSync
    .native(projectPath)
    .replaceAll('/', '-')
    .replaceAll('.', '-')
    .replaceAll(' ', '-');
  const projectDir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(path.join(projectDir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 's1.jsonl'),
    [
      assistant('m1', [
        { type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Survey', subagent_type: 'Explore' } },
      ]),
      '',
    ].join('\n'),
  );
  return { home, projectPath, sessionDir: path.join(projectDir, 's1', 'subagents') };
}

function writeAgent(sessionDir: string, agentId: string, toolUseId: string, rows: string[]): void {
  fs.writeFileSync(
    path.join(sessionDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: 'Explore', toolUseId, requestShape: 'background' }),
  );
  fs.writeFileSync(path.join(sessionDir, `agent-${agentId}.jsonl`), rows.join('\n') + '\n');
}

describe('loadClaudeSubagentHistory', () => {
  it('tags each subagent row with the tool_use id from its meta file', () => {
    const { projectPath, sessionDir } = setup();
    writeAgent(sessionDir, 'a1', 'toolu_bg', [
      line({ type: 'user', isSidechain: true, timestamp: '2026-10-15T10:00:01Z', message: { role: 'user', content: 'look around' } }),
      assistant('sm1', [{ type: 'text', text: 'Found it.' }], { isSidechain: true }),
    ]);
    const events = loadClaudeSubagentHistory('s1', projectPath, new Set(['toolu_bg']));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.parentToolUseId === 'toolu_bg')).toBe(true);
    expect(events.some((e) => e.kind.type === 'assistant' && e.kind.info.text === 'Found it.')).toBe(true);
  });

  it('skips agents whose card is not in the replay', () => {
    const { projectPath, sessionDir } = setup();
    writeAgent(sessionDir, 'a2', 'toolu_other', [assistant('sm2', [{ type: 'text', text: 'hi' }], { isSidechain: true })]);
    expect(loadClaudeSubagentHistory('s1', projectPath, new Set(['toolu_bg']))).toEqual([]);
  });

  it('returns nothing when the session has no subagents folder', () => {
    const { projectPath } = setup();
    expect(loadClaudeSubagentHistory('nope', projectPath, new Set(['toolu_bg']))).toEqual([]);
  });
});

describe('loadHistory with subagents', () => {
  it('appends the transcripts of subagents the replay launched', () => {
    const { projectPath, sessionDir } = setup();
    writeAgent(sessionDir, 'a1', 'toolu_bg', [assistant('sm1', [{ type: 'text', text: 'Report.' }], { isSidechain: true })]);
    const events = loadHistory({ backend: 'claude', projectPath, sessionId: 's1' });
    const sub = events.filter((e) => e.parentToolUseId === 'toolu_bg');
    expect(sub).toHaveLength(1);
    expect(sub[0].raw).toBe('');
  });
});
