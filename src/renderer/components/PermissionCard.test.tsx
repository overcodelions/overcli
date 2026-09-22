import { describe, expect, it } from 'vitest';
import { outboundSummary } from './PermissionCard';

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
