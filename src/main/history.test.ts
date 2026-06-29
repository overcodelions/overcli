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

  it('finds the Claude session dir case-insensitively when the cwd casing drifted', () => {
    // Simulates a flow whose cwd was cleaned up: claudeProjectSlug can no
    // longer realpath it, so the slug falls back to the raw stored path
    // (lowercase here), while Claude actually wrote the session under a
    // differently-cased directory. The transcript must still load.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-history-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    // Deliberately NOT created on disk → realpathSync.native throws inside
    // claudeProjectSlug → slug derives from the raw (lowercase) path.
    const projectPath = path.join(home, 'application support', 'overcli');
    const lowerSlug = projectPath.replaceAll('/', '-').replaceAll('.', '-').replaceAll(' ', '-');
    // The real on-disk dir uses different casing than the fallback slug.
    const realSlug = lowerSlug.replace('-overcli', '-Overcli');
    expect(realSlug).not.toBe(lowerSlug);

    const claudeDir = path.join(home, '.claude', 'projects', realSlug);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'user',
        timestamp: 1,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'survived the missing cwd' }],
            },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const events = loadHistory({ backend: 'claude', projectPath, sessionId: 'session-1' });
    expect(events.length).toBeGreaterThan(0);
  });

  it('replays copilot history from ~/.copilot/session-state/<id>/events.jsonl', () => {
    // Build a minimal fixture covering the lines parseCopilotLine
    // handles: user.message echoes (must synthesize as localUser since
    // the live parser drops them), assistant.message with toolRequests,
    // tool.execution_complete, and a final result. Streaming partials
    // (assistant.message_delta) must be dropped from history replay.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-copilot-history-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const sessionId = 'sess-copilot-1';
    const sessionDir = path.join(home, '.copilot', 'session-state', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [
      { type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } },
      { type: 'user.message', timestamp: '2026-05-17T22:09:51Z', data: { content: 'hello' } },
      // Streaming partial — must be dropped from replay.
      {
        type: 'assistant.message_start',
        data: { messageId: 'm1' },
      },
      {
        type: 'assistant.message_delta',
        data: { messageId: 'm1', deltaContent: 'Hi' },
      },
      // Final consolidated message — must survive.
      {
        type: 'assistant.message',
        data: {
          messageId: 'm1',
          content: 'Hi there',
          toolRequests: [
            { toolCallId: 'tc-1', name: 'view', arguments: { path: '/tmp/x' }, type: 'function' },
          ],
          reasoningText: '',
          model: 'claude-haiku-4.5',
        },
      },
      {
        type: 'tool.execution_complete',
        data: { toolCallId: 'tc-1', success: true, result: { content: 'listing...' } },
      },
      {
        type: 'result',
        sessionId,
        exitCode: 0,
        usage: { premiumRequests: 1, sessionDurationMs: 1000 },
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'events.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    );

    const events = loadHistory({
      backend: 'copilot',
      projectPath: home,
      sessionId,
    });

    const kinds = events.map((e) => e.kind.type);
    // Expected order: systemInit (from first session.tools_updated) →
    // localUser (synthesized from user.message) → assistant (final
    // message) → toolResult → result. No streaming partial leaks.
    expect(kinds).toEqual(['systemInit', 'localUser', 'assistant', 'toolResult', 'result']);
    const localUser = events[1];
    if (localUser.kind.type === 'localUser') {
      expect(localUser.kind.text).toBe('hello');
    }
    const assistantEv = events[2];
    if (assistantEv.kind.type === 'assistant') {
      expect(assistantEv.kind.info.text).toBe('Hi there');
      expect(assistantEv.kind.info.isPartial).toBeUndefined();
      expect(assistantEv.kind.info.toolUses).toHaveLength(1);
      expect(assistantEv.kind.info.toolUses[0].name).toBe('Read');
    }
  });

  it('returns [] for copilot history when sessionId is missing or file absent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-copilot-missing-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(loadHistory({ backend: 'copilot', projectPath: home })).toEqual([]);
    expect(
      loadHistory({ backend: 'copilot', projectPath: home, sessionId: 'does-not-exist' }),
    ).toEqual([]);
  });

  it('filters synthetic collab pingPrompts from copilot replay', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-copilot-synth-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const sessionId = 'sess-copilot-synth';
    const sessionDir = path.join(home, '.copilot', 'session-state', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const syntheticText = 'the reviewer said something';
    const { createHash } = require('node:crypto');
    const syntheticHash = createHash('sha256').update(syntheticText, 'utf8').digest('hex');

    const lines = [
      { type: 'user.message', timestamp: '2026-05-17T22:09:51Z', data: { content: 'real user' } },
      { type: 'user.message', timestamp: '2026-05-17T22:09:52Z', data: { content: syntheticText } },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'events.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    );

    const events = loadHistory({
      backend: 'copilot',
      projectPath: home,
      sessionId,
      syntheticPrompts: [syntheticHash],
    });

    expect(events.filter((e) => e.kind.type === 'localUser')).toHaveLength(1);
    const surviving = events.find((e) => e.kind.type === 'localUser');
    if (surviving && surviving.kind.type === 'localUser') {
      expect(surviving.kind.text).toBe('real user');
    }
  });
});
