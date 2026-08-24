import { describe, expect, it } from 'vitest';

import { isPathAtOrUnder, isPathUnder } from './pathScope';

const POSIX_ROOT = '/Users/bob/Documents/Overcli Projects/Brief';
const WIN_ROOT = 'C:\\Users\\bob\\Documents\\Overcli Projects\\Brief';

describe('isPathUnder', () => {
  it('matches a file inside a POSIX root', () => {
    expect(isPathUnder(`${POSIX_ROOT}/a.md`, POSIX_ROOT)).toBe(true);
    expect(isPathUnder(`${POSIX_ROOT}/notes/a.md`, POSIX_ROOT)).toBe(true);
  });

  // The whole reason this module exists: back-slashed paths used to fail
  // every containment check in the renderer, silently.
  it('matches a file inside a Windows root', () => {
    expect(isPathUnder(`${WIN_ROOT}\\a.md`, WIN_ROOT)).toBe(true);
    expect(isPathUnder(`${WIN_ROOT}\\notes\\a.md`, WIN_ROOT)).toBe(true);
  });

  it('matches when the two sides are spelled with different separators', () => {
    expect(isPathUnder('C:/Users/bob/Brief/a.md', 'C:\\Users\\bob\\Brief')).toBe(true);
    expect(isPathUnder('C:\\Users\\bob\\Brief\\a.md', 'C:/Users/bob/Brief')).toBe(true);
  });

  it('ignores a trailing separator on the root', () => {
    expect(isPathUnder(`${POSIX_ROOT}/a.md`, `${POSIX_ROOT}/`)).toBe(true);
    expect(isPathUnder(`${WIN_ROOT}\\a.md`, `${WIN_ROOT}\\`)).toBe(true);
  });

  it('is false for the root itself', () => {
    expect(isPathUnder(POSIX_ROOT, POSIX_ROOT)).toBe(false);
    expect(isPathUnder(WIN_ROOT, WIN_ROOT)).toBe(false);
  });

  // A sibling folder whose name merely starts with the root's name must not
  // count as being inside it — the separator is what makes it containment.
  it('is false for a sibling with a shared name prefix', () => {
    expect(isPathUnder(`${POSIX_ROOT} archive/a.md`, POSIX_ROOT)).toBe(false);
    expect(isPathUnder(`${WIN_ROOT} archive\\a.md`, WIN_ROOT)).toBe(false);
  });

  it('is false for an unrelated path, and for empty input', () => {
    expect(isPathUnder('/Users/bob/code/app/a.ts', POSIX_ROOT)).toBe(false);
    expect(isPathUnder('', POSIX_ROOT)).toBe(false);
    expect(isPathUnder(`${POSIX_ROOT}/a.md`, '')).toBe(false);
  });

  it('handles a drive root and a POSIX root', () => {
    expect(isPathUnder('C:\\Users\\bob\\a.md', 'C:\\')).toBe(true);
    expect(isPathUnder('/Users/bob/a.md', '/')).toBe(true);
  });

  it('stays case-sensitive, since both sides come from one source', () => {
    expect(isPathUnder('c:\\users\\bob\\Brief\\a.md', 'C:\\Users\\bob\\Brief')).toBe(false);
  });
});

describe('isPathAtOrUnder', () => {
  it('counts the root itself', () => {
    expect(isPathAtOrUnder(POSIX_ROOT, POSIX_ROOT)).toBe(true);
    expect(isPathAtOrUnder(WIN_ROOT, WIN_ROOT)).toBe(true);
    expect(isPathAtOrUnder(`${WIN_ROOT}\\`, WIN_ROOT)).toBe(true);
  });

  it('counts a file inside it, in either spelling', () => {
    expect(isPathAtOrUnder(`${POSIX_ROOT}/a.md`, POSIX_ROOT)).toBe(true);
    expect(isPathAtOrUnder(`${WIN_ROOT}\\a.md`, WIN_ROOT)).toBe(true);
  });

  it('is false for a sibling and for empty input', () => {
    expect(isPathAtOrUnder(`${WIN_ROOT} archive`, WIN_ROOT)).toBe(false);
    expect(isPathAtOrUnder('', POSIX_ROOT)).toBe(false);
  });
});
