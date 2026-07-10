import { describe, it, expect } from 'vitest';
import { codexCandidateBeats, pickBestCodexCandidate, type CodexBinaryCaps } from './runner';

function caps(
  version: [number, number, number],
  opts: { hasAppServer?: boolean; isScript?: boolean } = {},
): CodexBinaryCaps {
  return {
    hasAppServer: opts.hasAppServer ?? true,
    version,
    isScript: opts.isScript ?? false,
  };
}

describe('codexCandidateBeats', () => {
  it('prefers the higher version', () => {
    expect(codexCandidateBeats(caps([0, 144, 1]), caps([0, 30, 0]))).toBe(true);
    expect(codexCandidateBeats(caps([0, 30, 0]), caps([0, 144, 1]))).toBe(false);
  });

  it('compares version components major → minor → patch', () => {
    expect(codexCandidateBeats(caps([1, 0, 0]), caps([0, 999, 999]))).toBe(true);
    expect(codexCandidateBeats(caps([0, 30, 5]), caps([0, 30, 4]))).toBe(true);
  });

  it('breaks a version tie toward the native binary', () => {
    const native = caps([0, 144, 1], { isScript: false });
    const script = caps([0, 144, 1], { isScript: true });
    expect(codexCandidateBeats(native, script)).toBe(true);
    expect(codexCandidateBeats(script, native)).toBe(false);
  });

  it('is not strictly better when fully equal (stable first-seen wins)', () => {
    expect(codexCandidateBeats(caps([0, 144, 1]), caps([0, 144, 1]))).toBe(false);
  });
});

describe('pickBestCodexCandidate', () => {
  it('returns null when nothing supports app-server', () => {
    expect(
      pickBestCodexCandidate([
        { binary: '/opt/homebrew/bin/codex', caps: caps([0, 29, 0], { hasAppServer: false }) },
      ]),
    ).toBeNull();
  });

  it('ignores exec-only binaries even at a higher version', () => {
    // A newer exec-only build must not beat an older app-server build.
    const picked = pickBestCodexCandidate([
      { binary: '/exec-only', caps: caps([9, 0, 0], { hasAppServer: false }) },
      { binary: '/app-server', caps: caps([0, 30, 0], { hasAppServer: true }) },
    ]);
    expect(picked).toBe('/app-server');
  });

  it('picks the newest app-server binary regardless of list order', () => {
    // Stale-but-app-server binary listed first must not win over a newer one.
    const picked = pickBestCodexCandidate([
      { binary: '/stale', caps: caps([0, 30, 0]) },
      { binary: '/newest', caps: caps([0, 144, 1]) },
      { binary: '/middle', caps: caps([0, 90, 0]) },
    ]);
    expect(picked).toBe('/newest');
  });

  it('prefers the native binary when a script ties on version', () => {
    const picked = pickBestCodexCandidate([
      { binary: '/nvm/codex-script', caps: caps([0, 144, 1], { isScript: true }) },
      { binary: '/opt/homebrew/bin/codex', caps: caps([0, 144, 1], { isScript: false }) },
    ]);
    expect(picked).toBe('/opt/homebrew/bin/codex');
  });

  it('keeps the first-seen native binary when a later native ties', () => {
    const picked = pickBestCodexCandidate([
      { binary: '/first', caps: caps([0, 144, 1]) },
      { binary: '/second', caps: caps([0, 144, 1]) },
    ]);
    expect(picked).toBe('/first');
  });
});
