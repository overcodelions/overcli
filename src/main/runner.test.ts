import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import os from 'node:os';
import {
  AGENT_WORKING_LABEL,
  askUserQuestionHasData,
  isBrokerPromptToolMissingError,
  isStaleSessionError,
  makeIdleWatchdog,
  resumeSessionAfterParamChange,
  safeAttachmentBase,
  canPrewarm,
  reapTurnInFlight,
  shouldReapIdle,
  shouldReleaseClaudeBroker,
  shouldSkipIdleOnClose,
  spawnFailureMessage,
  staleRunningReason,
  resolveMcpScope,
  claudeMcpLaunchFingerprint,
  sanitizeSpawnArgs,
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

describe('shouldReleaseClaudeBroker', () => {
  // Regression: changing the model (or permission mode / cwd / turbo / effort)
  // mid-conversation makes sendSubprocess kill and relaunch the proc. The kill
  // used to unlink the broker's mcp-config and drop claudeMcpByConv, and the
  // relaunch is synchronous — prepareClaudeBroker had already run and doesn't
  // run again — so buildArgs found no config path and silently omitted
  // `--mcp-config` + `--permission-prompt-tool`. The replacement process then
  // had no channel to ask for permission, and every tool call needing approval
  // failed for the rest of the session with nothing shown in the UI.
  it('keeps the registration when the caller relaunches the same conversation', () => {
    expect(shouldReleaseClaudeBroker({ backend: 'claude', respawning: true })).toBe(false);
  });

  it('releases it on a real teardown — stop, delete, backend switch', () => {
    expect(shouldReleaseClaudeBroker({ backend: 'claude', respawning: false })).toBe(true);
  });

  it('is a no-op for backends that never register a broker', () => {
    for (const backend of ['codex', 'gemini', 'copilot', 'ollama'] as const) {
      expect(shouldReleaseClaudeBroker({ backend, respawning: false })).toBe(false);
      expect(shouldReleaseClaudeBroker({ backend, respawning: true })).toBe(false);
    }
  });
});

describe('spawnFailureMessage', () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

  it('identifies a removed working directory instead of blaming the CLI', () => {
    expect(
      spawnFailureMessage(
        { backend: 'claude', binary: '/usr/local/bin/claude', cwd: '/gone/worktree' },
        enoent,
        false,
      ),
    ).toContain('working directory no longer exists: `/gone/worktree`');
  });

  it('identifies a missing binary when the working directory still exists', () => {
    expect(
      spawnFailureMessage(
        { backend: 'claude', binary: '/missing/claude', cwd: '/repo' },
        enoent,
        true,
      ),
    ).toContain('`/missing/claude` was not found');
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

describe('staleRunningReason', () => {
  // Regression: the running indicator is edge-triggered, and two paths
  // turn it on without a guaranteed off — the reviewer await ("Rebounding…")
  // and the wait for a detached background agent ("Agent working…"). A
  // finished flow run kept a sidebar spinner for 13 hours because one of
  // its conversations was pinned this way.
  const base = { since: 0, lastEventAt: 0, hasTransport: true, turnInFlight: true };

  it('leaves a working turn alone even when it has been quiet a while', () => {
    // A single long tool call (test suite, build) emits nothing for
    // minutes — silence alone must never retract the indicator.
    expect(staleRunningReason({ ...base, label: 'Running tools…', now: 20 * 60_000 })).toBeNull();
  });

  it('leaves a transport that never reports turn boundaries alone', () => {
    // ollama / gemini ACP don't track it; unknown must read as "working".
    expect(
      staleRunningReason({ ...base, turnInFlight: undefined, now: 20 * 60_000 }),
    ).toBeNull();
  });

  it('waits out a reviewer that is genuinely running', () => {
    expect(
      staleRunningReason({
        ...base,
        turnInFlight: false,
        reviewerRunning: true,
        label: 'Rebounding…',
        now: 20 * 60_000,
      }),
    ).toBeNull();
  });

  it('retracts a hand-off left holding the indicator after the turn ended', () => {
    // e.g. "Rebounding…" whose reviewer is already gone — nothing outside
    // this process will ever speak for the conversation again.
    expect(
      staleRunningReason({ ...base, turnInFlight: false, label: 'Rebounding…', now: 20 * 60_000 }),
    ).toMatch(/turn already ended/);
  });

  it('retracts a conversation with nothing left to speak for it', () => {
    expect(staleRunningReason({ ...base, hasTransport: false, now: 5 * 60_000 })).toMatch(
      /no live transport/,
    );
  });

  it('gives a just-started send time to register its transport', () => {
    expect(staleRunningReason({ ...base, hasTransport: false, now: 5_000 })).toBeNull();
  });

  it('bounds the wait on a background agent that never reports completion', () => {
    const parked = { ...base, turnInFlight: false, label: AGENT_WORKING_LABEL };
    expect(staleRunningReason({ ...parked, now: 60_000 })).toBeNull();
    expect(staleRunningReason({ ...parked, now: 10 * 60_000 })).toMatch(/background agent/);
  });

  it('measures silence from the last event, not the turn start', () => {
    // Progress ticks keep pushing the deadline out; only a genuinely
    // silent wait gets cut loose.
    expect(
      staleRunningReason({
        since: 0,
        lastEventAt: 9 * 60_000,
        hasTransport: true,
        turnInFlight: false,
        label: AGENT_WORKING_LABEL,
        now: 10 * 60_000,
      }),
    ).toBeNull();
  });
});

describe('shouldReapIdle', () => {
  // Regression: `claude -p --input-format stream-json` stays resident with
  // all its MCP servers loaded for as long as stdin is open. A user with a
  // few dozen conversations they'd each sent one message to was holding
  // ~22 GB in sessions that had been finished for hours.
  const base = {
    turnInFlight: false,
    hasPendingPrompts: false,
    canResume: true,
    lastActivityAt: 0,
    timeoutMinutes: 30,
  };

  it('reaps a session whose turn ended and has been silent past the timeout', () => {
    expect(shouldReapIdle({ ...base, now: 31 * 60_000 })).toBe(true);
  });

  it('leaves a session alone until the timeout elapses', () => {
    expect(shouldReapIdle({ ...base, now: 29 * 60_000 })).toBe(false);
  });

  it('reaps exactly at the timeout boundary', () => {
    expect(shouldReapIdle({ ...base, now: 30 * 60_000 })).toBe(true);
  });

  it('never reaps a turn that is still running, however long it has been quiet', () => {
    // A long tool call — a full test suite, a big build — is silent for
    // minutes at a time and must not be mistaken for a parked session.
    expect(shouldReapIdle({ ...base, turnInFlight: true, now: 10 * 60 * 60_000 })).toBe(false);
  });

  it('never reaps a transport that does not report turn state', () => {
    expect(shouldReapIdle({ ...base, turnInFlight: undefined, now: 10 * 60 * 60_000 })).toBe(false);
  });

  it('never reaps while a prompt is waiting on the user', () => {
    // Killing the process here strands the permission dialog and loses
    // the turn behind it — the user stepped away, they didn't finish.
    expect(shouldReapIdle({ ...base, hasPendingPrompts: true, now: 10 * 60 * 60_000 })).toBe(false);
  });

  it('never reaps a session with nothing to resume from', () => {
    // Without a sessionId the respawn starts a fresh, context-free thread —
    // reclaiming memory by silently discarding the conversation.
    expect(shouldReapIdle({ ...base, canResume: false, now: 10 * 60 * 60_000 })).toBe(false);
  });

  it('is disabled by a zero (or negative) timeout', () => {
    expect(shouldReapIdle({ ...base, timeoutMinutes: 0, now: 10 * 60 * 60_000 })).toBe(false);
    expect(shouldReapIdle({ ...base, timeoutMinutes: -5, now: 10 * 60 * 60_000 })).toBe(false);
  });

  it('measures silence from the last activity, not from spawn', () => {
    expect(shouldReapIdle({ ...base, lastActivityAt: 60 * 60_000, now: 61 * 60_000 })).toBe(false);
    expect(shouldReapIdle({ ...base, lastActivityAt: 60 * 60_000, now: 95 * 60_000 })).toBe(true);
  });
});

describe('makeIdleWatchdog', () => {
  // Regression: the orchestrator producer ran under a flat 300s wall clock.
  // A schedule whose prompt spanned two issue trackers and three repos died
  // with "Timed out after 300s." every morning — killed mid-investigation
  // while it was still streaming tool calls. A wall clock can't tell "busy"
  // from "wedged"; only silence can.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expires after an unbroken stretch of silence', () => {
    const onExpire = vi.fn();
    const wd = makeIdleWatchdog({ idleMs: 1000, onExpire });
    wd.bump();
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never expires while activity keeps arriving', () => {
    const onExpire = vi.fn();
    const wd = makeIdleWatchdog({ idleMs: 1000, onExpire });
    wd.bump();
    // Ten minutes of a slow-but-alive turn: each event lands inside the
    // budget, so the deadline is pushed out and never arrives.
    for (let i = 0; i < 600; i++) {
      vi.advanceTimersByTime(900);
      wd.bump();
    }
    expect(onExpire).not.toHaveBeenCalled();
    // ...and it still expires once the activity actually stops.
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stays quiet after cancel, even if a later bump slips in', () => {
    // The turn finished; a trailing event must not resurrect the timer and
    // resolve an already-settled one-shot a second time.
    const onExpire = vi.fn();
    const wd = makeIdleWatchdog({ idleMs: 1000, onExpire });
    wd.bump();
    wd.cancel();
    wd.bump();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('is inert without an idle budget — the caller keeps a plain wall clock', () => {
    const onExpire = vi.fn();
    const wd = makeIdleWatchdog({ idleMs: undefined, onExpire });
    wd.bump();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe('canPrewarm', () => {
  const base = {
    backend: 'claude' as const,
    claudeTransport: 'cli' as const,
    claudeSdkFallback: false,
    hasRuntime: false,
    sendPending: false,
  };

  it('warms claude on the cli transport', () => {
    expect(canPrewarm(base)).toBe(true);
  });

  it('warms codex', () => {
    // The exec-vs-app-server split is probed by the caller; eligibility
    // only rules the backend in.
    expect(canPrewarm({ ...base, backend: 'codex' })).toBe(true);
  });

  it('skips the claude SDK transport — there is no subprocess to start', () => {
    expect(canPrewarm({ ...base, claudeTransport: 'sdk' })).toBe(false);
    expect(canPrewarm({ ...base, claudeSdkFallback: true })).toBe(false);
  });

  it.each(['gemini', 'copilot', 'ollama'] as const)(
    'skips %s — no resident subprocess to warm',
    (backend) => expect(canPrewarm({ ...base, backend })).toBe(false),
  );

  it('skips a conversation that already has a runtime', () => {
    // Includes a prewarm already in flight: `spawnFor` registers the process
    // synchronously, so a second warm-up would orphan the first.
    expect(canPrewarm({ ...base, hasRuntime: true })).toBe(false);
  });

  it('skips a conversation with a real send in flight', () => {
    // Losing this race would leave two processes with one map entry.
    expect(canPrewarm({ ...base, sendPending: true })).toBe(false);
  });

  it('a runtime beats every other signal', () => {
    expect(canPrewarm({ ...base, backend: 'codex', hasRuntime: true })).toBe(false);
  });
});

describe('shouldReapIdle — unused prewarm', () => {
  // The reap refuses to collect a process it cannot resume, which would make
  // a never-used prewarm immortal: no turn ever runs on it, so no sessionId
  // ever arrives. Callers pass `canResume: true` for one because there is no
  // history to lose — this pins that reasoning.
  it('collects an unused prewarm once idle', () => {
    expect(
      shouldReapIdle({
        turnInFlight: reapTurnInFlight({ prewarmed: true }),
        hasPendingPrompts: false,
        canResume: true,
        lastActivityAt: 0,
        timeoutMinutes: 30,
        now: 31 * 60_000,
      }),
    ).toBe(true);
  });

  it('still leaves a session-less, never-prewarmed process alone', () => {
    expect(
      shouldReapIdle({
        turnInFlight: false,
        hasPendingPrompts: false,
        canResume: false,
        lastActivityAt: 0,
        timeoutMinutes: 30,
        now: 31 * 60_000,
      }),
    ).toBe(false);
  });

  // Regression: this suite used to hand `shouldReapIdle` a literal
  // `turnInFlight: false`, a state a prewarm can never actually reach.
  // `spawnFor` never stamps the field and a prewarm never writes stdin, so
  // the real value is undefined — which the first guard rejects, leaving the
  // reap's `unusedPrewarm` allowance dead and the process immortal. The
  // suite was green over the bug because it asserted the intended policy
  // against a state the runtime does not produce.
  it('reads a real prewarm as having no turn in flight', () => {
    expect(reapTurnInFlight({ prewarmed: true, turnInFlight: undefined })).toBe(false);
  });

  it('would not be reaped without that mapping', () => {
    expect(
      shouldReapIdle({
        turnInFlight: undefined,
        hasPendingPrompts: false,
        canResume: true,
        lastActivityAt: 0,
        timeoutMinutes: 30,
        now: 31 * 60_000,
      }),
    ).toBe(false);
  });

  it('leaves a live turn alone even on a process still flagged prewarmed', () => {
    expect(reapTurnInFlight({ prewarmed: false, turnInFlight: true })).toBe(true);
  });

  // ollama / gemini ACP report no turn state and must keep reading as busy.
  it('passes undefined through for a non-prewarmed process', () => {
    expect(reapTurnInFlight({ turnInFlight: undefined })).toBeUndefined();
  });
});

describe('safeAttachmentBase', () => {
  // Regression: an attachment id like "../../.claude/settings" was joined
  // straight into the attachments dir, writing outside it. A traversal id
  // must fall back to a fresh uuid and land back inside the dir. Exercised
  // directly, on an in-memory dir string, rather than through
  // `writeAttachmentFile` — that path touches the real
  // `~/.overcli/attachments` on disk (and sweeps it), which a unit test
  // must not do.
  const dir = path.join(os.tmpdir(), 'overcli-attachments-test');

  it('rejects a traversal id and falls back to a uuid inside the dir', () => {
    const file = safeAttachmentBase('../../evil', dir, '.json');
    expect(file.startsWith(dir + path.sep)).toBe(true);
    expect(file).not.toContain('../../evil');
    expect(file).not.toContain('..');
  });

  it('keeps a safe id as the filename', () => {
    const file = safeAttachmentBase('att-123', dir, '.json');
    expect(file).toBe(path.join(dir, 'att-123.json'));
  });

  it('falls back to a fresh uuid when no id is given', () => {
    const file = safeAttachmentBase(undefined, dir, '.json');
    expect(file.startsWith(dir + path.sep)).toBe(true);
    expect(file.endsWith('.json')).toBe(true);
  });
});

describe('resolveMcpScope', () => {

  it('inherits the whole config when nothing asked for scoping', () => {
    expect(resolveMcpScope({ backend: 'claude', cwd: '/repo' })).toEqual({
      skipGlobalMcp: undefined,
    });
  });

  it('makes every Claude allowlist strict without inline JSON', () => {
    expect(resolveMcpScope({ backend: 'claude', cwd: '/repo', mcpAllowlist: ['jira'] })).toEqual({
      skipGlobalMcp: true,
    });
  });

  it('loads none for an explicitly empty list, on any backend', () => {
    expect(resolveMcpScope({ backend: 'claude', cwd: '/repo', mcpAllowlist: [] })).toEqual({
      skipGlobalMcp: true,
    });
    expect(resolveMcpScope({ backend: 'codex', cwd: '/repo', mcpAllowlist: [] })).toEqual({
      skipGlobalMcp: true,
    });
  });

  it('loads none — not all — when named servers resolve to nothing', () => {
    // The failure this guards: a worker that named one server, which the user
    // has since removed, silently going back to inheriting all seven.
    expect(
      resolveMcpScope({ backend: 'claude', cwd: '/repo', mcpAllowlist: ['gone'] }),
    ).toEqual({ skipGlobalMcp: true });
  });

  it('lets a backend it cannot narrow keep everything', () => {
    // Stripping tools the job needs breaks the worker; paying for tools it
    // doesn't costs what it already cost yesterday.
    expect(resolveMcpScope({ backend: 'codex', cwd: '/repo', mcpAllowlist: ['jira'] })).toEqual({
      skipGlobalMcp: undefined,
    });
  });
});

describe('claudeMcpLaunchFingerprint', () => {
  it('distinguishes inherited servers from strict empty or unresolved allowlists', () => {
    const inherited = claudeMcpLaunchFingerprint({ backend: 'claude' }, '');
    const empty = claudeMcpLaunchFingerprint({ backend: 'claude', mcpAllowlist: [] }, '');
    const unresolved = claudeMcpLaunchFingerprint({ backend: 'claude', mcpAllowlist: ['gone'] }, '');

    expect(empty).not.toBe(inherited);
    expect(unresolved).not.toBe(inherited);
    expect(empty).toBe(unresolved);
  });

  it('distinguishes direct strict mode and resolved server changes', () => {
    const inherited = claudeMcpLaunchFingerprint({ backend: 'claude' }, '');
    const strict = claudeMcpLaunchFingerprint({ backend: 'claude', skipGlobalMcp: true }, '');
    const jira = claudeMcpLaunchFingerprint(
      { backend: 'claude', mcpAllowlist: ['jira'] },
      '{"mcpServers":{"jira":{}}}',
    );
    const slack = claudeMcpLaunchFingerprint(
      { backend: 'claude', mcpAllowlist: ['slack'] },
      '{"mcpServers":{"slack":{}}}',
    );

    expect(strict).not.toBe(inherited);
    expect(jira).not.toBe(slack);
  });
});

describe('sanitizeSpawnArgs', () => {
  it('redacts every variadic MCP config value and its credentials', () => {
    const safe = sanitizeSpawnArgs([
      '--mcp-config', '/tmp/broker.json', '{"Authorization":"Bearer secret"}', '--strict-mcp-config',
    ]);
    expect(safe).toEqual(['--mcp-config', '<mcp config redacted>', '<mcp config redacted>', '--strict-mcp-config']);
    expect(safe.join(' ')).not.toContain('Authorization');
    expect(safe.join(' ')).not.toContain('secret');
  });
});
