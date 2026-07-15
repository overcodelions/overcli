import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codexPermissionMapping,
  codexTransportPermissions,
  extractRequestedPath,
  geminiPermissionMapping,
  isInsideAllowedDirs,
  normalizeAllowedDirs,
} from './permissionRules';
import { summarizeToolUse } from './toolDescription';
import { collapsePartialAssistants, extractCodexExecSnapshot } from './streamSnapshot';
import {
  askUserQuestionHasData,
  isBrokerPromptToolMissingError,
  isStaleSessionError,
  resumeSessionAfterParamChange,
  shouldSkipIdleOnClose,
} from './runner';
import type { StreamEvent } from '../shared/types';

describe('resumeSessionAfterParamChange', () => {
  // Regression: changing a flow participant's model in the hijack chat
  // killed the live Claude process and respawned it without --resume,
  // because that send path doesn't thread sessionId through. The new
  // model then saw none of the prior conversation.
  it('falls back to the live session when the caller did not supply one', () => {
    expect(resumeSessionAfterParamChange(undefined, 'live-sess')).toBe('live-sess');
  });

  it('prefers the caller-supplied sessionId (normal chat threads conv.sessionId)', () => {
    expect(resumeSessionAfterParamChange('caller-sess', 'live-sess')).toBe('caller-sess');
  });

  it('treats an empty caller sessionId as absent', () => {
    expect(resumeSessionAfterParamChange('', 'live-sess')).toBe('live-sess');
  });

  it('returns undefined when neither side has a session (first turn)', () => {
    expect(resumeSessionAfterParamChange(undefined, undefined)).toBeUndefined();
  });
});

describe('shouldSkipIdleOnClose', () => {
  // Regression: same model-swap path as above. Bumping a flow participant's
  // model in the hijack chat makes the next send kill and respawn the proc.
  // The dead proc's 'close' landed a second AFTER the flow runtime had
  // started a step on that conversation, and its running:false was read as
  // "step finished" — so "Re-run from here" failed the step off an empty
  // buffer ("produced no <output>") and never updated the artifact, while
  // the respawned proc was still working the step for real.
  it('silences a superseded proc — the replacement turn owns the running state', () => {
    expect(
      shouldSkipIdleOnClose({ isCurrent: false, backend: 'claude', claudeSendPending: false }),
    ).toBe(true);
    expect(
      shouldSkipIdleOnClose({ isCurrent: false, backend: 'codex', claudeSendPending: false }),
    ).toBe(true);
  });

  it('lets the conversation’s current proc report idle', () => {
    expect(
      shouldSkipIdleOnClose({ isCurrent: true, backend: 'claude', claudeSendPending: false }),
    ).toBe(false);
    expect(
      shouldSkipIdleOnClose({ isCurrent: true, backend: 'codex', claudeSendPending: false }),
    ).toBe(false);
  });

  it('still silences the current proc while a fresh Claude send prepares its broker', () => {
    // The replacement send hasn't registered a proc yet, so the closing one
    // is technically still "current" — but a turn is already inbound.
    expect(
      shouldSkipIdleOnClose({ isCurrent: true, backend: 'claude', claudeSendPending: true }),
    ).toBe(true);
  });

  it('does not apply the Claude-only broker window to other backends', () => {
    expect(
      shouldSkipIdleOnClose({ isCurrent: true, backend: 'codex', claudeSendPending: true }),
    ).toBe(false);
  });
});

describe('isStaleSessionError', () => {
  it('matches claude "no conversation found with session id"', () => {
    expect(isStaleSessionError('Error: No conversation found with session ID abc-123')).toBe(true);
  });

  it('matches a bare "session not found"', () => {
    expect(isStaleSessionError('fatal: session not found')).toBe(true);
  });

  it('matches "resume" and "not found" co-occurring (gemini/codex phrasing)', () => {
    expect(isStaleSessionError('Could not resume conversation: rollout not found')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isStaleSessionError('SESSION NOT FOUND')).toBe(true);
  });

  it('does not fire on unrelated "not found" errors', () => {
    // Guards the substring matcher against false positives: these contain
    // "not found" but are not stale-session failures.
    expect(isStaleSessionError('file not found')).toBe(false);
    expect(isStaleSessionError('model not found')).toBe(false);
    expect(isStaleSessionError('command not found: claude')).toBe(false);
    expect(isStaleSessionError('404 not found')).toBe(false);
  });

  it('returns false for empty / non-stale output', () => {
    expect(isStaleSessionError('')).toBe(false);
    expect(isStaleSessionError('rate limit exceeded')).toBe(false);
  });
});

describe('isBrokerPromptToolMissingError', () => {
  it('matches the real "permission-prompt-tool not found" failure', () => {
    const stderr =
      'Error: MCP tool mcp__overcli__approve (passed via --permission-prompt-tool) not found. ' +
      'Available MCP tools: mcp__claude_ai_Unifyr_MCP__authenticate, mcp__aws-knowledge-mcp-server__aws___recommend';
    expect(isBrokerPromptToolMissingError(stderr)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(
      isBrokerPromptToolMissingError(
        'MCP TOOL MCP__OVERCLI__APPROVE PASSED VIA --PERMISSION-PROMPT-TOOL NOT FOUND',
      ),
    ).toBe(true);
  });

  it('does not fire on unrelated tool-not-found errors', () => {
    // A different MCP tool missing, or a stale-session "not found", must
    // not trigger the SDK fallback.
    expect(isBrokerPromptToolMissingError('Tool mcp__github__create_issue not found')).toBe(false);
    expect(isBrokerPromptToolMissingError('No conversation found with session ID abc')).toBe(false);
    expect(isBrokerPromptToolMissingError('')).toBe(false);
  });
});

describe('askUserQuestionHasData', () => {
  // Regression: the runner used to end the Claude turn (and kill the proc)
  // the moment an AskUserQuestion tool_use was merely *present*, even when
  // its inputJSON hadn't accumulated any questions yet. That left
  // AskUserQuestionCard stuck on "No options provided — type your reply
  // below." because the process was already dead by the time real data
  // would have arrived.
  it('returns true when questions is a non-empty array', () => {
    expect(
      askUserQuestionHasData(
        JSON.stringify({ questions: [{ header: 'Pick one', question: 'Which?', options: [] }] }),
      ),
    ).toBe(true);
  });

  it('returns true for multiple questions', () => {
    expect(
      askUserQuestionHasData(JSON.stringify({ questions: [{ question: 'A' }, { question: 'B' }] })),
    ).toBe(true);
  });

  it('returns false for the omitted-input case ("{}")', () => {
    // This is exactly what claude.ts:283 produces when the SDK's
    // consolidated assistant message omits `block.input`.
    expect(askUserQuestionHasData('{}')).toBe(false);
  });

  it('returns false when questions is present but empty', () => {
    expect(askUserQuestionHasData(JSON.stringify({ questions: [] }))).toBe(false);
  });

  it('returns false when questions is not an array', () => {
    expect(askUserQuestionHasData(JSON.stringify({ questions: 'not-an-array' }))).toBe(false);
    expect(askUserQuestionHasData(JSON.stringify({ questions: { header: 'oops' } }))).toBe(false);
  });

  it('returns false for unparseable JSON (partial streaming snapshot)', () => {
    expect(askUserQuestionHasData('{"questions": [')).toBe(false);
    expect(askUserQuestionHasData('')).toBe(false);
  });

  it('returns false when the payload parses to a non-object', () => {
    // Guards the optional-chaining access: these must not throw.
    expect(askUserQuestionHasData('null')).toBe(false);
    expect(askUserQuestionHasData('42')).toBe(false);
    expect(askUserQuestionHasData('"a string"')).toBe(false);
  });
});

describe('codexPermissionMapping', () => {
  it('plan → read-only sandbox, on-request approvals', () => {
    expect(codexPermissionMapping('plan')).toEqual({ sandbox: 'read-only', approval: 'on-request' });
  });

  it('acceptEdits → workspace-write sandbox, on-failure approvals', () => {
    expect(codexPermissionMapping('acceptEdits')).toEqual({ sandbox: 'workspace-write', approval: 'on-failure' });
  });

  it('bypassPermissions → danger-full-access sandbox, never approve', () => {
    expect(codexPermissionMapping('bypassPermissions')).toEqual({ sandbox: 'danger-full-access', approval: 'never' });
  });

  it('default → workspace-write sandbox, on-request approvals', () => {
    expect(codexPermissionMapping('default')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
  });

  it('auto falls back to default mapping (auto is Claude-only)', () => {
    expect(codexPermissionMapping('auto')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
  });
});

describe('codexTransportPermissions', () => {
  it('always returns approval: never so app-server handles approvals itself', () => {
    for (const mode of ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(codexTransportPermissions(mode).approval).toBe('never');
    }
  });

  it('keeps the sandbox level from codexPermissionMapping', () => {
    expect(codexTransportPermissions('plan').sandbox).toBe('read-only');
    expect(codexTransportPermissions('bypassPermissions').sandbox).toBe('danger-full-access');
  });
});

describe('geminiPermissionMapping', () => {
  it('maps overcli modes to gemini --approval-mode values', () => {
    expect(geminiPermissionMapping('plan')).toBe('plan');
    expect(geminiPermissionMapping('acceptEdits')).toBe('auto_edit');
    expect(geminiPermissionMapping('bypassPermissions')).toBe('yolo');
    expect(geminiPermissionMapping('default')).toBe('default');
    // `auto` is Claude-only; gemini falls back to its default approval flow.
    expect(geminiPermissionMapping('auto')).toBe('default');
  });
});

describe('normalizeAllowedDirs', () => {
  it('returns [] for undefined or empty input', () => {
    expect(normalizeAllowedDirs('/tmp/project', undefined)).toEqual([]);
    expect(normalizeAllowedDirs('/tmp/project', [])).toEqual([]);
  });

  it('drops cwd and resolves to absolute paths', () => {
    const out = normalizeAllowedDirs('/tmp/project', ['/tmp/project', '/tmp/other']);
    expect(out).toEqual(['/tmp/other']);
  });

  it('dedupes duplicates', () => {
    const out = normalizeAllowedDirs('/tmp/project', ['/a', '/a', '/b']);
    expect(out).toEqual(['/a', '/b']);
  });

  it('filters out falsy entries', () => {
    const out = normalizeAllowedDirs('/tmp/project', ['', '/a', '']);
    expect(out).toEqual(['/a']);
  });
});

describe('extractRequestedPath', () => {
  it('returns file_path when it is absolute', () => {
    expect(extractRequestedPath('Read', { file_path: '/etc/hosts' })).toBe('/etc/hosts');
  });

  it('returns path as a fallback field', () => {
    expect(extractRequestedPath('Glob', { path: '/usr/local' })).toBe('/usr/local');
  });

  it('returns notebook_path for notebook tools', () => {
    expect(extractRequestedPath('NotebookEdit', { notebook_path: '/home/u/note.ipynb' })).toBe('/home/u/note.ipynb');
  });

  it('ignores non-absolute paths', () => {
    expect(extractRequestedPath('Read', { file_path: 'relative/path.txt' })).toBeNull();
  });

  it('pulls an absolute path out of a Bash command', () => {
    expect(extractRequestedPath('Bash', { command: 'ls /var/log' })).toBe('/var/log');
  });

  it('returns null when Bash command has no absolute path', () => {
    expect(extractRequestedPath('Bash', { command: 'ls relative/dir' })).toBeNull();
  });

  it('returns null for non-object inputs', () => {
    expect(extractRequestedPath('Read', null)).toBeNull();
    expect(extractRequestedPath('Read', 'just a string')).toBeNull();
  });
});

describe('isInsideAllowedDirs', () => {
  const cwd = '/tmp/project';

  it('returns true for a path inside cwd', () => {
    expect(isInsideAllowedDirs('/tmp/project/src/foo.ts', cwd, [])).toBe(true);
  });

  it('returns true for cwd itself', () => {
    expect(isInsideAllowedDirs(cwd, cwd, [])).toBe(true);
  });

  it('returns true for a path inside an allowed dir', () => {
    expect(isInsideAllowedDirs('/opt/shared/lib.ts', cwd, ['/opt/shared'])).toBe(true);
  });

  it('returns false for a path outside cwd and all allowed dirs', () => {
    expect(isInsideAllowedDirs('/etc/passwd', cwd, ['/opt/shared'])).toBe(false);
  });

  it('does not treat a sibling prefix as inside (cwd /tmp/proj vs /tmp/proj-other)', () => {
    expect(isInsideAllowedDirs('/tmp/project-other/file', cwd, [])).toBe(false);
  });

  it('normalizes paths with trailing separators', () => {
    expect(isInsideAllowedDirs('/tmp/project/', cwd, [])).toBe(true);
  });
});

describe('summarizeToolUse', () => {
  it('summarizes a Bash command from a string command field', () => {
    const out = summarizeToolUse('Bash', JSON.stringify({ command: 'npm test' }));
    expect(out).toBe('• Bash: npm test');
  });

  it('joins array command fields with spaces', () => {
    const out = summarizeToolUse('shell', JSON.stringify({ command: ['npm', 'run', 'build'] }));
    expect(out).toBe('• Bash: npm run build');
  });

  it('truncates long Bash commands to 240 chars + ellipsis', () => {
    const long = 'a'.repeat(300);
    const out = summarizeToolUse('Bash', JSON.stringify({ command: long }));
    expect(out.startsWith('• Bash: ')).toBe(true);
    expect(out.length).toBe('• Bash: '.length + 240 + 1); // 1 for ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('summarizes Edit / Write / Read using the explicit filePath argument', () => {
    expect(summarizeToolUse('Edit', '{}', '/src/a.ts')).toBe('• Edit /src/a.ts');
    expect(summarizeToolUse('Write', '{}', '/src/b.ts')).toBe('• Write /src/b.ts');
    expect(summarizeToolUse('Read', '{}', '/src/c.ts')).toBe('• Read /src/c.ts');
  });

  it('falls back to parsed file_path when filePath is not passed', () => {
    const out = summarizeToolUse('Edit', JSON.stringify({ file_path: '/src/a.ts' }));
    expect(out).toBe('• Edit /src/a.ts');
  });

  it('summarizes TodoWrite with the todo count', () => {
    const out = summarizeToolUse('TodoWrite', JSON.stringify({ todos: [{}, {}, {}] }));
    expect(out).toBe('• TodoWrite (3)');
  });

  it('falls back to name + truncated input JSON for unknown tools', () => {
    const out = summarizeToolUse('MysteryTool', '{"a":1}');
    expect(out).toBe('• MysteryTool {"a":1}');
  });

  it('handles malformed Bash JSON by treating the whole string as the command', () => {
    const out = summarizeToolUse('Bash', 'rm -rf /tmp/foo');
    expect(out).toBe('• Bash: rm -rf /tmp/foo');
  });
});

describe('extractCodexExecSnapshot', () => {
  it('returns empty on empty/whitespace input', () => {
    expect(extractCodexExecSnapshot('')).toEqual({ text: '', thinking: '' });
    expect(extractCodexExecSnapshot('   \n  ')).toEqual({ text: '', thinking: '' });
  });

  it('picks up [ts] codex and [ts] thinking sections from the new timestamped format', () => {
    const raw = [
      '[2026-04-21T10:00:00] OpenAI Codex',
      'banner',
      '[2026-04-21T10:00:01] thinking',
      'reasoning step',
      '[2026-04-21T10:00:02] codex',
      'here is the answer.',
    ].join('\n');
    expect(extractCodexExecSnapshot(raw)).toEqual({
      text: 'here is the answer.',
      thinking: 'reasoning step',
    });
  });

  it('concatenates multiple codex blocks with blank-line separators', () => {
    const raw = [
      '[2026-04-21T10:00:00] codex',
      'part one.',
      '[2026-04-21T10:00:01] codex',
      'part two.',
    ].join('\n');
    expect(extractCodexExecSnapshot(raw).text).toBe('part one.\n\npart two.');
  });

  it('falls back to plain "thinking\\n...\\ncodex\\n..." sections on older codex output', () => {
    const raw = [
      'User instructions:',
      'prompt',
      '',
      'thinking',
      'I will do the thing',
      '',
      'codex',
      'done.',
      '',
      'tokens used',
      '12',
    ].join('\n');
    const snap = extractCodexExecSnapshot(raw);
    expect(snap.text).toBe('done.');
    expect(snap.thinking).toBe('I will do the thing');
  });

  it('uses the raw trimmed text as last resort when no markers match', () => {
    const raw = 'some unstructured output';
    expect(extractCodexExecSnapshot(raw)).toEqual({ text: 'some unstructured output', thinking: '' });
  });
});

describe('collapsePartialAssistants', () => {
  const mkPartial = (id: string, text: string): StreamEvent => ({
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: null, text, toolUses: [], thinking: [], isPartial: true },
    },
  });
  const mkFinal = (id: string, text: string): StreamEvent => ({
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: null, text, toolUses: [], thinking: [] },
    },
  });
  const mkTool = (id: string): StreamEvent => ({
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: { type: 'toolResult', results: [{ id: 't', content: '', isError: false }] },
  });

  it('returns the input untouched when there are no partials', () => {
    const input = [mkFinal('a', 'hi'), mkTool('t')];
    expect(collapsePartialAssistants(input)).toBe(input);
  });

  it('keeps only the last partial per id, preserving order', () => {
    const input = [
      mkPartial('A', 'H'),
      mkPartial('A', 'He'),
      mkTool('t'),
      mkPartial('A', 'Hello'),
      mkFinal('B', 'done'),
    ];
    const out = collapsePartialAssistants(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(input[2]); // tool result preserved at its position
    expect(out[1]).toBe(input[3]); // last partial for A
    expect(out[2]).toBe(input[4]); // B's final assistant
  });

  it('does not collapse across distinct ids', () => {
    const input = [mkPartial('A', 'a'), mkPartial('B', 'b'), mkPartial('A', 'aa')];
    const out = collapsePartialAssistants(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[1]); // B's only partial
    expect(out[1]).toBe(input[2]); // A's latest partial
  });
});
