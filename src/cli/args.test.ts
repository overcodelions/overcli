import { describe, expect, it } from 'vitest';

import { defaultCwd, parseArgs } from './args';

function run(argv: string[]) {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.args;
}

describe('parseArgs', () => {
  it('defaults to the safe permission policy', () => {
    expect(run(['run', 'f.yaml']).run?.permissions).toBe('deny');
  });

  it('accepts --flag value and --flag=value alike', () => {
    expect(run(['run', 'f.yaml', '--cwd', '/a']).run?.cwd).toBe('/a');
    expect(run(['run', 'f.yaml', '--cwd=/a']).run?.cwd).toBe('/a');
  });

  it('collects repeated and comma-separated allow-tools', () => {
    const opts = run(['run', 'f.yaml', '--permissions', 'allow-list', '--allow-tool', 'Read,Grep', '--allow-tool', 'Bash']).run;
    expect(opts?.allowTools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('parses a model override into from and to', () => {
    expect(run(['run', 'f.yaml', '--model-override', 'ollama=claude:sonnet']).run?.modelOverrides).toEqual([
      { from: 'ollama', to: 'claude:sonnet' },
    ]);
  });

  it('rejects an unknown permission policy rather than falling back', () => {
    const r = parseArgs(['run', 'f.yaml', '--permissions', 'yolo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('deny, allow-list, auto-approve');
  });

  it('rejects a model override with no "="', () => {
    expect(parseArgs(['run', 'f.yaml', '--model-override', 'ollama']).ok).toBe(false);
  });

  it('rejects an unknown option instead of ignoring it', () => {
    const r = parseArgs(['run', 'f.yaml', '--permisions', 'deny']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--permisions');
  });

  it('needs exactly one file', () => {
    expect(parseArgs(['run']).ok).toBe(false);
    expect(parseArgs(['run', 'a.yaml', 'b.yaml']).ok).toBe(false);
  });

  it('warns that allow-list with no tools is just deny', () => {
    expect(run(['run', 'f.yaml', '--permissions', 'allow-list']).warnings.join(' ')).toContain(
      'denies everything',
    );
  });

  it('warns that --allow-tool does nothing outside allow-list', () => {
    expect(run(['run', 'f.yaml', '--allow-tool', 'Read']).warnings.join(' ')).toContain('only applies');
  });

  it('defaults a worker to probation rather than assuming autonomy', () => {
    expect(run(['run', 'w.yaml']).run?.trust).toBe('probation');
  });

  it('accepts an explicit trust level', () => {
    expect(run(['run', 'w.yaml', '--trust', 'autonomous']).run?.trust).toBe('autonomous');
  });

  it('rejects a trust level it does not know', () => {
    const r = parseArgs(['run', 'w.yaml', '--trust', 'total']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('probation, trusted, autonomous');
  });

  it('treats no arguments and --help the same', () => {
    expect(run([]).command).toBe('help');
    expect(run(['--help']).command).toBe('help');
  });
});

describe('defaultCwd', () => {
  it('prefers the GitHub Actions workspace', () => {
    expect(defaultCwd({ GITHUB_WORKSPACE: '/gh', WORKSPACE: '/jenkins' }, '/here')).toBe('/gh');
  });

  it('falls back to the Jenkins workspace, then the process cwd', () => {
    expect(defaultCwd({ WORKSPACE: '/jenkins' }, '/here')).toBe('/jenkins');
    expect(defaultCwd({}, '/here')).toBe('/here');
  });

  it('ignores an empty variable rather than running in ""', () => {
    expect(defaultCwd({ GITHUB_WORKSPACE: '   ' }, '/here')).toBe('/here');
  });
});
