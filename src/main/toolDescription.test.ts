import { describe, expect, it } from 'vitest';
import { summarizeToolUse } from './toolDescription';

describe('summarizeToolUse — extra coverage', () => {
  it('handles non-JSON Bash input by treating it as the raw command', () => {
    expect(summarizeToolUse('Bash', 'rm -rf /tmp/foo')).toBe('• Bash: rm -rf /tmp/foo');
  });

  it('truncates long Bash commands at 240 chars with an ellipsis', () => {
    const cmd = 'a'.repeat(500);
    const out = summarizeToolUse('Bash', JSON.stringify({ command: cmd }));
    // '• Bash: ' (8 chars) + 240 truncated + '…' (1 char)
    expect(out.length).toBe(249);
    expect(out.endsWith('…')).toBe(true);
  });

  it('joins array commands with spaces', () => {
    expect(
      summarizeToolUse('shell', JSON.stringify({ command: ['npm', 'run', 'build'] })),
    ).toBe('• Bash: npm run build');
  });

  it('aliases shell and exec_command to Bash', () => {
    expect(summarizeToolUse('shell', JSON.stringify({ command: 'ls' }))).toMatch(/Bash/);
    expect(summarizeToolUse('exec_command', JSON.stringify({ command: 'ls' }))).toMatch(/Bash/);
  });

  it('prefers explicit filePath over parsed file_path for Edit/Write/Read', () => {
    expect(summarizeToolUse('Edit', JSON.stringify({ file_path: '/x' }), '/y')).toBe('• Edit /y');
    expect(summarizeToolUse('Write', JSON.stringify({ file_path: '/x' }), '/y')).toBe('• Write /y');
    expect(summarizeToolUse('Read', JSON.stringify({ file_path: '/x' }), '/y')).toBe('• Read /y');
  });

  it('falls back to parsed file_path when filePath is omitted', () => {
    expect(summarizeToolUse('Edit', JSON.stringify({ file_path: '/x.ts' }))).toBe('• Edit /x.ts');
  });

  it('treats MultiEdit like Edit', () => {
    expect(summarizeToolUse('MultiEdit', '{}', '/x.ts')).toBe('• Edit /x.ts');
  });

  it('reports TodoWrite count', () => {
    expect(summarizeToolUse('TodoWrite', JSON.stringify({ todos: [{}, {}] }))).toBe(
      '• TodoWrite (2)',
    );
    expect(summarizeToolUse('TodoWrite', JSON.stringify({ todos: [] }))).toBe('• TodoWrite (0)');
  });

  it('TodoWrite with malformed input still reports 0', () => {
    expect(summarizeToolUse('TodoWrite', 'not json')).toBe('• TodoWrite (0)');
  });

  it('falls back to a generic line for unknown tools', () => {
    const out = summarizeToolUse('CustomTool', '{"x":1}');
    expect(out).toContain('CustomTool');
    expect(out).toContain('{"x":1}');
  });
});
