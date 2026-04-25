import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codexPermissionMapping,
  codexTransportPermissions,
  collapsePartialAssistants,
  extractCodexExecSnapshot,
  extractRequestedPath,
  geminiPermissionMapping,
  isInsideAllowedDirs,
  normalizeAllowedDirs,
  summarizeToolUse,
} from './runner';
import type { StreamEvent } from '../shared/types';

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
});

describe('codexTransportPermissions', () => {
  it('always returns approval: never so app-server handles approvals itself', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(codexTransportPermissions(mode).approval).toBe('never');
    }
  });

  it('keeps the sandbox level from codexPermissionMapping', () => {
    expect(codexTransportPermissions('plan').sandbox).toBe('read-only');
    expect(codexTransportPermissions('bypassPermissions').sandbox).toBe('danger-full-access');
  });
});

describe('geminiPermissionMapping', () => {
  it('maps the four modes to gemini --approval-mode values', () => {
    expect(geminiPermissionMapping('plan')).toBe('plan');
    expect(geminiPermissionMapping('acceptEdits')).toBe('auto_edit');
    expect(geminiPermissionMapping('bypassPermissions')).toBe('yolo');
    expect(geminiPermissionMapping('default')).toBe('default');
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
