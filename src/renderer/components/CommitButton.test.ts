import { describe, expect, it } from 'vitest';
import { draftCommitMessage } from './CommitButton';

describe('draftCommitMessage', () => {
  it('returns empty string for an empty changeset', () => {
    expect(draftCommitMessage([])).toBe('');
  });

  it('uses the basename for a single-file change', () => {
    expect(draftCommitMessage([{ path: 'src/foo/bar.ts' }])).toBe('Update bar.ts');
  });

  it('uses the basename for a single root-level file', () => {
    expect(draftCommitMessage([{ path: 'README.md' }])).toBe('Update README.md');
  });

  it('uses the directory name when all files share a top-level dir', () => {
    expect(
      draftCommitMessage([
        { path: 'src/a.ts' },
        { path: 'src/b.ts' },
        { path: 'src/nested/c.ts' },
      ]),
    ).toBe('Update src');
  });

  it('falls back to a file count when files span multiple dirs', () => {
    expect(
      draftCommitMessage([
        { path: 'src/a.ts' },
        { path: 'docs/b.md' },
      ]),
    ).toBe('Update 2 files');
  });

  it('falls back to a file count when files are all root-level', () => {
    expect(
      draftCommitMessage([{ path: 'a.ts' }, { path: 'b.ts' }]),
    ).toBe('Update 2 files');
  });
});
