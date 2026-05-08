import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  buildReviewerArgs,
  extractReviewerDisplay,
  parseClaudeStreamJson,
} from './reviewer';

describe('buildReviewerArgs', () => {
  it('reads claude prompt from stdin with stream-json output (so we can capture the session id for warm --resume), low effort, default permission mode (no tools in -p)', () => {
    expect(buildReviewerArgs('claude')).toEqual([
      '--effort',
      'low',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git ls-files:*)',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '-p',
      '-',
    ]);
  });

  it('uses the per-persona effort for claude (security gets medium instead of the default low)', () => {
    const args = buildReviewerArgs('claude', { effort: 'medium' });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
  });

  it('appends --resume <id> for claude when a prior session id is known', () => {
    expect(buildReviewerArgs('claude', { resumeSessionId: 'abc-123' })).toEqual([
      '--resume',
      'abc-123',
      '--effort',
      'low',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git ls-files:*)',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '-p',
      '-',
    ]);
  });

  it('passes --skip-git-repo-check to codex exec so reviewer runs in non-git workspace roots', () => {
    expect(buildReviewerArgs('codex')).toEqual(['exec', '--skip-git-repo-check', '-']);
  });

  it('adds workspace-write sandbox + never-approve when yolo is on for codex', () => {
    // -s and -a are top-level codex flags (not exec flags), so they
    // come before the `exec` subcommand. Putting them after `exec`
    // makes the parser reject `--ask-for-approval` as an unknown arg.
    expect(buildReviewerArgs('codex', { yolo: true })).toEqual([
      '-s',
      'workspace-write',
      '-a',
      'never',
      'exec',
      '--skip-git-repo-check',
      '-',
    ]);
  });

  it('appends --add-dir for each writable root in yolo codex mode', () => {
    expect(
      buildReviewerArgs('codex', {
        yolo: true,
        writableRoots: ['/tmp/proj-a', '/tmp/proj-b'],
      }),
    ).toEqual([
      '-s',
      'workspace-write',
      '-a',
      'never',
      'exec',
      '--skip-git-repo-check',
      '--add-dir',
      '/tmp/proj-a',
      '--add-dir',
      '/tmp/proj-b',
      '-',
    ]);
  });

  it('ignores yolo for non-codex backends', () => {
    expect(buildReviewerArgs('claude', { yolo: true })).toEqual([
      '--effort',
      'low',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git ls-files:*)',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '-p',
      '-',
    ]);
    expect(buildReviewerArgs('gemini', { yolo: true })).toEqual(['-p', '-']);
  });

  it('reads gemini prompt from stdin', () => {
    expect(buildReviewerArgs('gemini')).toEqual(['-p', '-']);
  });

  it('throws for ollama (uses HTTP path instead)', () => {
    expect(() => buildReviewerArgs('ollama')).toThrow(/dispatched via runOllama/);
  });
});

describe('buildReviewPrompt', () => {
  const summary = {
    primaryBackend: 'claude',
    userPrompt: 'refactor the runner',
    assistantText: 'done — split into two files',
    toolActivity: '• Edit runner.ts\n• Write runner2.ts',
  };

  it('includes the sanity-check role instruction on round 1', () => {
    const prompt = buildReviewPrompt(summary, 1);
    expect(prompt).toMatch(/Sanity-check the turn below by claude/);
    expect(prompt).toContain('User: refactor the runner');
    expect(prompt).toContain('claude: done — split into two files');
    expect(prompt).toContain('Tools: • Edit runner.ts');
  });

  it('drops the role instruction on later rounds', () => {
    const prompt = buildReviewPrompt(summary, 2);
    expect(prompt).not.toMatch(/Sanity-check/);
    expect(prompt).toContain('User: refactor the runner');
  });

  it('omits the Tools section when none were used', () => {
    const prompt = buildReviewPrompt({ ...summary, toolActivity: '(no tools used)' }, 1);
    expect(prompt).not.toContain('Tools:');
  });

  it('falls back to "(no text)" when the assistant emitted nothing', () => {
    const prompt = buildReviewPrompt({ ...summary, assistantText: '' }, 1);
    expect(prompt).toContain('claude: (no text)');
  });
});

describe('extractReviewerDisplay', () => {
  it('returns plain trimmed text for gemini (still uses one-shot plain-text mode)', () => {
    expect(extractReviewerDisplay('  looks fine  ', 'gemini')).toBe('looks fine');
  });

  it('extracts the latest assistant text from claude stream-json events', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-xyz' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'looks fine' }] },
      }),
    ].join('\n');
    expect(extractReviewerDisplay(raw, 'claude')).toBe('looks fine');
  });

  it('returns empty string for claude when stdout has no assistant events yet', () => {
    expect(extractReviewerDisplay('', 'claude')).toBe('');
    expect(
      extractReviewerDisplay(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
        'claude',
      ),
    ).toBe('');
  });

  it('extracts thinking blocks separately from text so the renderer can show "what was checked" above the verdict', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Scanning for stubs and TODOs...' },
          { type: 'text', text: 'Looks complete.' },
        ],
      },
    });
    const parsed = parseClaudeStreamJson(raw);
    expect(parsed.text).toBe('Looks complete.');
    expect(parsed.thinking).toBe('Scanning for stubs and TODOs...');
  });

  it('keeps only [ts] codex sections from codex exec transcripts', () => {
    const raw = [
      '[2026-04-21T10:00:00] OpenAI Codex v0.5',
      'banner noise',
      '[2026-04-21T10:00:01] User instructions:',
      'echoed prompt',
      '[2026-04-21T10:00:02] thinking',
      'internal reasoning',
      '[2026-04-21T10:00:03] codex',
      'The change looks good.',
      '[2026-04-21T10:00:04] tokens used: 1234',
    ].join('\n');
    expect(extractReviewerDisplay(raw, 'codex')).toBe('The change looks good.');
  });

  it('joins multiple codex sections with a blank line', () => {
    const raw = [
      '[2026-04-21T10:00:00] codex',
      'first half.',
      '[2026-04-21T10:00:01] thinking',
      'aside',
      '[2026-04-21T10:00:02] codex',
      'second half.',
    ].join('\n');
    expect(extractReviewerDisplay(raw, 'codex')).toBe('first half.\n\nsecond half.');
  });

  it('falls back to stripping the token-usage footer when no structured sections have arrived yet', () => {
    const raw = 'early partial output\nToken usage: 12 in, 34 out';
    expect(extractReviewerDisplay(raw, 'codex')).toBe('early partial output');
  });

  it('returns empty string for empty input', () => {
    expect(extractReviewerDisplay('', 'codex')).toBe('');
    expect(extractReviewerDisplay('', 'claude')).toBe('');
  });
});
