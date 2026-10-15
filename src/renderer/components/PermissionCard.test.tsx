import { describe, expect, it } from 'vitest';
import { actionSummary, alwaysAllowLabel, outboundSummary } from './PermissionCard';

describe('Artifact permission summaries', () => {
  it.each([
    ['publish', 'Publishes'],
    ['delete', 'PERMANENTLY deletes'],
    ['read', 'Reads'],
    ['list', 'Lists'],
    ['open', 'Opens'],
    ['pin', 'Pins'],
    ['unpin', 'Unpins'],
    ['quickstart', 'Reads'],
  ])('describes the %s action', (action, phrase) => {
    expect(outboundSummary('Artifact', JSON.stringify({ action }))?.headline).toContain(phrase);
  });

  it('shows and counts every distinct local upload source', () => {
    const summary = outboundSummary('Artifact', JSON.stringify({
      action: 'publish',
      file_path: '/tmp/index.html',
      files: { script: '/tmp/app.js', duplicate: '/tmp/index.html' },
      file_paths: ['/tmp/style.css'],
      root: '/tmp/assets',
    }));

    expect(summary?.headline).toContain('4 local files');
    expect(summary?.rows.filter((row) => row.label.startsWith('File')).map((row) => row.value)).toEqual([
      '/tmp/index.html',
      '/tmp/app.js',
      '/tmp/style.css',
      '/tmp/assets',
    ]);
  });
});

describe('alwaysAllowLabel', () => {
  it('reads a rule in plain terms', () => {
    expect(alwaysAllowLabel('Bash(npm test:*)')).toBe('Always allow npm test');
    expect(alwaysAllowLabel('WebFetch(domain:docs.example.com)')).toBe('Always allow docs.example.com');
    expect(alwaysAllowLabel('Edit')).toBe('Always allow Edit');
  });
});

describe('actionSummary', () => {
  it('pulls the command or file out of the request', () => {
    expect(actionSummary('Bash', JSON.stringify({ command: 'npm test' }))).toEqual({ label: 'Runs', value: 'npm test' });
    expect(actionSummary('Edit', JSON.stringify({ file_path: '/a/b.ts' }))).toEqual({ label: 'Edits', value: '/a/b.ts' });
    expect(actionSummary('Write', JSON.stringify({ file_path: '/a/c.ts' }))).toEqual({ label: 'Writes', value: '/a/c.ts' });
  });

  it('leaves other tools and bad input to the raw JSON', () => {
    expect(actionSummary('mcp__acme__send', JSON.stringify({ to: 'x' }))).toBeNull();
    expect(actionSummary('Bash', '{not json')).toBeNull();
  });
});
