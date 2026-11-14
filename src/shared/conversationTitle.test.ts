import { describe, expect, it } from 'vitest';
import {
  buildExcerpt,
  composeTitle,
  findRefs,
  leadingRef,
  placeholderName,
  readTitleReply,
  shouldRetitle,
} from './conversationTitle';

describe('findRefs', () => {
  it('finds ticket keys and skips standards that look like them', () => {
    expect(findRefs(['Fix ACME-412, the UTF-8 decode and SHA-256 bits'])).toEqual(['ACME-412']);
  });
  it('ranks by mentions, then first seen', () => {
    expect(findRefs(['ABC-1 then XYZ-2', 'more on XYZ-2'])).toEqual(['XYZ-2', 'ABC-1']);
  });
  it('reads lower-case keys from the branch and weights them', () => {
    expect(findRefs(['also see ABC-9'], 'feat/acme-412-retry')).toEqual(['ACME-412', 'ABC-9']);
  });
  it('finds PRs from links and prose', () => {
    expect(findRefs(['look at https://github.com/o/r/pull/1107 and PR #12'])).toEqual(['PR #1107', 'PR #12']);
  });
});

describe('leadingRef / composeTitle', () => {
  it('leads with one ticket and one PR', () => {
    expect(leadingRef(['PR #5', 'A-1', 'B-2'])).toBe('A-1 · PR #5');
    expect(leadingRef([])).toBeNull();
  });
  it('prefixes the ref and strips a repeat of it', () => {
    expect(composeTitle('ACME-412', 'ACME-412: Fix login retry')).toBe('ACME-412 · Fix login retry');
    expect(composeTitle('PR #9', 'Review comments (PR #9)')).toBe('PR #9 · Review comments');
    expect(composeTitle(null, 'Fix login retry')).toBe('Fix login retry');
  });
});

describe('shouldRetitle', () => {
  const base = { name: 'Something', ref: null };
  it('titles after the first reply, then turn 3, then every 8', () => {
    expect(shouldRetitle({ ...base, turnCount: 1 })).toBe(true);
    expect(shouldRetitle({ ...base, turnCount: 2, titledAtTurn: 1 })).toBe(false);
    expect(shouldRetitle({ ...base, turnCount: 3, titledAtTurn: 1 })).toBe(true);
    expect(shouldRetitle({ ...base, turnCount: 10, titledAtTurn: 3 })).toBe(false);
    expect(shouldRetitle({ ...base, turnCount: 11, titledAtTurn: 3 })).toBe(true);
  });
  it('retitles at once when a new ref shows up', () => {
    expect(shouldRetitle({ name: 'Login retry', ref: 'ACME-4', turnCount: 2, titledAtTurn: 1 })).toBe(true);
    expect(shouldRetitle({ name: 'ACME-4 · Login retry', ref: 'ACME-4', turnCount: 2, titledAtTurn: 1 })).toBe(false);
  });
});

describe('readTitleReply', () => {
  it('cleans quotes, labels and full stops', () => {
    expect(readTitleReply('Title: "Retry backoff in login client."')).toBe('Retry backoff in login client');
  });
  it('recognises KEEP', () => {
    expect(readTitleReply('KEEP')).toBe('keep');
  });
  it('cuts long replies at a word', () => {
    const t = readTitleReply('word '.repeat(30)) as string;
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith(' ')).toBe(false);
  });
  it('rejects an empty reply', () => {
    expect(readTitleReply('  ')).toBeNull();
  });
});

describe('placeholderName / buildExcerpt', () => {
  it('cuts the placeholder to 48', () => {
    expect(placeholderName('  a\n b  ')).toBe('a b');
    expect(placeholderName('x'.repeat(100))).toHaveLength(48);
  });
  it('keeps the opening ask and the latest messages within budget', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i} ` + 'x'.repeat(300) }));
    const ex = buildExcerpt(msgs, { total: 1500 });
    expect(ex.startsWith('Developer: m0')).toBe(true);
    expect(ex).toContain('…\n');
    expect(ex).toContain('m19');
    expect(ex.length).toBeLessThanOrEqual(1500);
  });
});
