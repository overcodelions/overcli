import { describe, expect, it } from 'vitest';

import { isPathAtOrUnder, isPathUnder, isSamePath } from './pathScope';

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

describe('isSamePath', () => {
  // The case this exists for. A run persisted before the app declared a
  // productName spells its userData directory `overcli`; the workspace record
  // written since spells it `Overcli`. One directory, and a strict compare
  // reported the workspace as unknown — the sidebar lane lost its name and
  // printed the bare uuid instead.
  const ID = '5f99d358-8e16-4acb-b5e4-6f63e763b392';
  const STORED = `/Users/bob/Library/Application Support/Overcli/workspaces/${ID}`;
  const ON_RUN = `/Users/bob/Library/Application Support/overcli/workspaces/${ID}`;

  it('matches the two spellings of the userData directory', () => {
    expect(isSamePath(STORED, ON_RUN)).toBe(true);
  });

  it('still separates two genuinely different workspaces', () => {
    expect(isSamePath(STORED, STORED.replace(ID, 'b234ddc0-ad59-4ae2-ac14-4d2231cc5dd7'))).toBe(
      false,
    );
  });

  it('folds the separator and a trailing slash, like the checks above', () => {
    expect(isSamePath(WIN_ROOT, `${WIN_ROOT.replace(/\\/g, '/')}/`)).toBe(true);
  });

  it('is false for empty input rather than matching another empty', () => {
    expect(isSamePath('', '')).toBe(false);
    expect(isSamePath(POSIX_ROOT, '')).toBe(false);
  });
});
