import { describe, it, expect } from 'vitest';
import {
  appendContextNotice,
  trimContextNotices,
  MAX_PENDING_CONTEXT_NOTICES,
} from './contextNotices';

/// Mirrors the real shape from buildWorkspaceUpdateNotice — a bracketed
/// header, then a body that itself contains a blank line. The blank line is
/// the reason we split on the header instead.
const notice = (name: string) =>
  [
    '[Workspace context update]',
    'Added member projects:',
    `- ${name} → /Users/x/git/${name}`,
    '',
    'The workspace CLAUDE.md / AGENTS.md / GEMINI.md have been refreshed.',
  ].join('\n');

describe('trimContextNotices', () => {
  it('returns undefined for empty input', () => {
    expect(trimContextNotices(undefined)).toBeUndefined();
    expect(trimContextNotices(null)).toBeUndefined();
    expect(trimContextNotices('')).toBeUndefined();
    expect(trimContextNotices('   \n  ')).toBeUndefined();
  });

  it('leaves a single notice untouched', () => {
    expect(trimContextNotices(notice('alpha'))).toBe(notice('alpha'));
  });

  it('preserves a notice body that contains blank lines', () => {
    const trimmed = trimContextNotices(notice('alpha'));
    expect(trimmed).toContain('Added member projects:');
    expect(trimmed).toContain('have been refreshed.');
  });

  it('keeps distinct notices in chronological order', () => {
    const joined = [notice('a'), notice('b'), notice('c')].join('\n\n');
    expect(trimContextNotices(joined)).toBe(joined);
  });

  it('dedupes repeats, keeping the most recent position', () => {
    const joined = [notice('a'), notice('b'), notice('a')].join('\n\n');
    expect(trimContextNotices(joined)).toBe([notice('b'), notice('a')].join('\n\n'));
  });

  it('caps at the most recent MAX notices', () => {
    const many = Array.from({ length: 20 }, (_, i) => notice(`p${i}`));
    const trimmed = trimContextNotices(many.join('\n\n'));
    const kept = many.slice(-MAX_PENDING_CONTEXT_NOTICES);
    expect(trimmed).toBe(kept.join('\n\n'));
    expect(trimmed).not.toContain('p0 ');
  });

  it('handles the two real header variants together', () => {
    const agent = '[Workspace agent update]\nNew member projects were added.';
    const joined = [notice('a'), agent].join('\n\n');
    expect(trimContextNotices(joined)).toBe(joined);
  });

  it('passes through text with no recognizable header rather than dropping it', () => {
    expect(trimContextNotices('some legacy freeform text')).toBe('some legacy freeform text');
  });

  it('keeps leading text that precedes the first header', () => {
    const withPreamble = `stray preamble\n\n${notice('a')}`;
    expect(trimContextNotices(withPreamble)).toContain('stray preamble');
  });

  it('collapses a real-world backlog to the cap', () => {
    // 103 stacked notices, 73 distinct — the shape found in a live store.
    const blocks = Array.from({ length: 103 }, (_, i) => notice(`p${i % 73}`));
    const trimmed = trimContextNotices(blocks.join('\n\n'))!;
    expect(trimmed.split('[Workspace context update]').length - 1).toBe(
      MAX_PENDING_CONTEXT_NOTICES,
    );
    expect(trimmed.length).toBeLessThan(2000);
  });
});

describe('appendContextNotice', () => {
  it('returns the notice when nothing is queued', () => {
    expect(appendContextNotice(undefined, notice('a'))).toBe(notice('a'));
    expect(appendContextNotice('', notice('a'))).toBe(notice('a'));
  });

  it('appends a distinct notice', () => {
    expect(appendContextNotice(notice('a'), notice('b'))).toBe(
      [notice('a'), notice('b')].join('\n\n'),
    );
  });

  it('does not grow when the same notice repeats', () => {
    const once = appendContextNotice(undefined, notice('a'));
    const twice = appendContextNotice(once, notice('a'));
    expect(twice).toBe(once);
  });

  it('stays bounded across many appends', () => {
    let acc: string | undefined;
    for (let i = 0; i < 200; i += 1) acc = appendContextNotice(acc, notice(`p${i}`));
    expect(acc!.split('[Workspace context update]').length - 1).toBe(
      MAX_PENDING_CONTEXT_NOTICES,
    );
  });

  it('retains the newest notice', () => {
    let acc: string | undefined;
    for (let i = 0; i < 200; i += 1) acc = appendContextNotice(acc, notice(`p${i}`));
    expect(acc).toContain('p199');
  });
});
