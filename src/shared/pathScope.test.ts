import { describe, expect, it } from 'vitest';

import {
  canonicalizeUnderRoot,
  isPathAtOrUnder,
  isPathUnder,
  isSamePath,
} from './pathScope';

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

// The case-folding in `isSamePath` is off on Linux by design, and
// `caseSensitiveFs()` reads `process.platform` at call time. Tests about the
// fold therefore have to say which filesystem they mean: asserting the macOS
// answer unpinned passed locally and went red the moment CI ran it on Ubuntu,
// where the two spellings genuinely are two directories.
function onPlatform<T>(value: string, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    return body();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const ID = '5f99d358-8e16-4acb-b5e4-6f63e763b392';
const USERDATA = '/Users/bob/Library/Application Support/Overcli';
const STORED = `${USERDATA}/workspaces/${ID}`;
const ON_RUN = `/Users/bob/Library/Application Support/overcli/workspaces/${ID}`;

describe('isSamePath', () => {
  // The case this exists for. A run persisted before the app declared a
  // productName spells its userData directory `overcli`; the workspace record
  // written since spells it `Overcli`. One directory, and a strict compare
  // reported the workspace as unknown — the sidebar lane lost its name and
  // printed the bare uuid instead.
  it('matches the two spellings of the userData directory', () => {
    expect(onPlatform('darwin', () => isSamePath(STORED, ON_RUN))).toBe(true);
  });

  it('keeps the two spellings apart on a case-sensitive filesystem', () => {
    expect(onPlatform('linux', () => isSamePath(STORED, ON_RUN))).toBe(false);
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

describe('canonicalizeUnderRoot', () => {
  it('rewrites a stale userData spelling to the current one', () => {
    expect(onPlatform('darwin', () => canonicalizeUnderRoot(ON_RUN, USERDATA))).toBe(STORED);
  });

  it('leaves an already-canonical path exactly as it found it', () => {
    expect(onPlatform('darwin', () => canonicalizeUnderRoot(STORED, USERDATA))).toBe(STORED);
  });

  it('tolerates a trailing separator on the root', () => {
    expect(onPlatform('darwin', () => canonicalizeUnderRoot(ON_RUN, `${USERDATA}/`))).toBe(
      STORED,
    );
  });

  it('leaves a path outside the root alone', () => {
    expect(onPlatform('darwin', () => canonicalizeUnderRoot(POSIX_ROOT, USERDATA))).toBe(
      POSIX_ROOT,
    );
  });

  // `…/Overcli-backup` starts with the root as a STRING but is a different
  // directory. Rewriting it would silently repoint records at the live one.
  it('does not match the root mid-segment', () => {
    const sibling = `${USERDATA.toLowerCase()}-backup/workspaces/${ID}`;
    expect(onPlatform('darwin', () => canonicalizeUnderRoot(sibling, USERDATA))).toBe(sibling);
  });

  // Two real directories on Linux — rewriting one to the other would point a
  // run at a workspace root that does not exist.
  it('is a no-op on a case-sensitive filesystem', () => {
    expect(onPlatform('linux', () => canonicalizeUnderRoot(ON_RUN, USERDATA))).toBe(ON_RUN);
  });
});
