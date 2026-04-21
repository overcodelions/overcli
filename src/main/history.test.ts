import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHistory } from './history';

describe('loadHistory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes Claude tool_result arrays on history reload', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-history-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const projectPath = path.join(home, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });

    const slug = fs.realpathSync.native(projectPath).replaceAll('/', '-').replaceAll('.', '-').replaceAll(' ', '-');
    const claudeDir = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'user',
        timestamp: 123,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: '## Heading' }, { text: 'Line two' }, 'tail'],
            },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const events = loadHistory({
      backend: 'claude',
      projectPath,
      sessionId: 'session-1',
    });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toEqual({
      type: 'toolResult',
      results: [
        {
          id: 'tool-1',
          content: '## Heading\nLine two\ntail',
          isError: false,
        },
      ],
    });
  });
});
