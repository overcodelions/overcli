import { describe, expect, it } from 'vitest';
import { workspaceSymlinkNames } from './workspaceNames';

describe('workspaceSymlinkNames', () => {
  it('uses the path basename as the link name', () => {
    const out = workspaceSymlinkNames([
      { name: 'Front End', path: '/Users/me/code/frontend' },
    ]);
    expect(out).toEqual([{ name: 'frontend', path: '/Users/me/code/frontend' }]);
  });

  it('deduplicates colliding basenames with a -2 / -3 suffix', () => {
    const out = workspaceSymlinkNames([
      { name: 'one', path: '/a/frontend' },
      { name: 'two', path: '/b/frontend' },
      { name: 'three', path: '/c/frontend' },
    ]);
    expect(out.map((o) => o.name)).toEqual(['frontend', 'frontend-2', 'frontend-3']);
    expect(out.map((o) => o.path)).toEqual(['/a/frontend', '/b/frontend', '/c/frontend']);
  });

  it('falls back to a slugified display name when the path has no basename', () => {
    // Trailing slash → basename is empty, so the display name kicks in.
    const out = workspaceSymlinkNames([{ name: 'My Cool Project!', path: '/foo/' }]);
    expect(out).toEqual([{ name: 'my-cool-project', path: '/foo/' }]);
  });

  it('falls back to "project" when neither path basename nor name slug resolve', () => {
    const out = workspaceSymlinkNames([{ name: '!!!', path: '/foo/' }]);
    expect(out).toEqual([{ name: 'project', path: '/foo/' }]);
  });

  it('skips entries with no path', () => {
    const out = workspaceSymlinkNames([
      { name: 'keep', path: '/a/keep' },
      { name: 'drop', path: '' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('keep');
  });

  it('handles Windows-style paths with backslashes', () => {
    const out = workspaceSymlinkNames([{ name: 'win', path: 'C:\\code\\winapp' }]);
    expect(out).toEqual([{ name: 'winapp', path: 'C:\\code\\winapp' }]);
  });

  it('returns [] for an empty input', () => {
    expect(workspaceSymlinkNames([])).toEqual([]);
  });
});
