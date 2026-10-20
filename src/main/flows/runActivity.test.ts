import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MainToRendererEvent } from '../../shared/types';
import { describeTool, RunActivity } from './runActivity';

const stream = (events: unknown[]): MainToRendererEvent => ({ type: 'stream', conversationId: 'c1', events }) as unknown as MainToRendererEvent;
const assistant = (text: string, tools: Array<[string, unknown]> = []) => ({ timestamp: 1_000, kind: { type: 'assistant', info: { text, toolUses: tools.map(([name, input], i) => ({ id: `t${i}`, name, inputJSON: JSON.stringify(input) })), thinking: [] } } });

describe('a run, in words', () => {
  it('says each tool call plainly, never the whole input', () => {
    expect(describeTool('Read', '{"file_path":"/data/team-files/t1/pieces/roadmap-items.md"}')).toBe('Read pieces/roadmap-items.md');
    expect(describeTool('WebSearch', '{"query":"partner ecosystem MCP 2026"}')).toBe('Searched the web: partner ecosystem MCP 2026');
    expect(describeTool('mcp__claude_ai_Acme_Wiki__searchIssuesUsingQuery', '{"jql":"project = ACME"}')).toBe('Acme Wiki: search issues using query (project = ACME)');
    expect(describeTool('Bash', JSON.stringify({ command: 'x'.repeat(300) })).length).toBeLessThan(110);
  });
});

describe('run activity', () => {
  let dir = '';
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it('records what a run did, keeps it across a restart, and lets it go after the org keeps things', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-activity-'));
    const a = new RunActivity((c) => (c === 'c1' ? 'r1' : undefined), { dir, keepDays: () => 7 });
    a.observe(stream([assistant('Reading the scores first.', [['Read', { file_path: '/x/SCORING.md' }]]), { timestamp: 1_500, kind: { type: 'toolResult', results: [{ id: 't0', content: 'denied', isError: true }] } }]));
    a.observe(stream([{ timestamp: 1_200, kind: { type: 'assistant', info: { text: 'partial', toolUses: [], thinking: [], isPartial: true } } }]));
    expect(a.list('r1').map((x) => [x.kind, x.text])).toEqual([
      ['said', 'Reading the scores first.'],
      ['tool', 'Read x/SCORING.md'],
      ['error', 'denied'],
    ]);
    expect(a.list('r1', 1_000).map((x) => x.kind)).toEqual(['error']);
    await new Promise((r) => setTimeout(r, 20));
    // A new server reads it back from disk.
    const again = new RunActivity(() => undefined, { dir, keepDays: () => 7 });
    expect(again.list('r1')).toHaveLength(3);
    // Older than the org keeps things: gone.
    expect(again.prune(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(new RunActivity(() => undefined, { dir, keepDays: () => 7 }).list('r1')).toEqual([]);
  });
});
