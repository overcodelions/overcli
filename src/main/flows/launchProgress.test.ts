import { describe, expect, it } from 'vitest';
import { launchProgressMessage, launchTimingSummary } from './launchProgress';

describe('launchProgressMessage', () => {
  const at = (pending: string[], ok = true) => launchProgressMessage({ justFinished: 'acme-web', ok, pending });

  it('names the finished repo while many remain', () => {
    expect(at(['a', 'b', 'c', 'd'])).toBe('Prepared worktree for acme-web');
  });
  it('names what is holding the launch up once few remain', () => {
    expect(at(['acme-api', 'acme-db'])).toBe('Waiting on acme-api, acme-db');
  });
  it('says when it is done, and a failure always wins', () => {
    expect(at([])).toBe('Worktrees ready');
    expect(at(['a'], false)).toBe('Worktree failed for acme-web');
  });
});

describe('launchTimingSummary', () => {
  it('gives the total and the slowest three', () => {
    const line = launchTimingSummary(
      [{ name: 'a', ms: 100 }, { name: 'b', ms: 9000 }, { name: 'c', ms: 2000 }, { name: 'd', ms: 3000 }],
      9500,
    );
    expect(line).toBe('Prepared 4 worktrees in 9.5s; slowest: b 9.0s, d 3.0s, c 2.0s');
  });
});
