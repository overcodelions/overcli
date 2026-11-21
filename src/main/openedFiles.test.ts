import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearOpenedFiles, isOpenedFile, noteOpenedFile } from './openedFiles';

afterEach(() => clearOpenedFiles());

function folder(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-opened-')));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# hi');
  fs.writeFileSync(path.join(dir, 'beside.md'), 'secret');
  return dir;
}

describe('opened files', () => {
  it('allows exactly the file opened, not what sits beside it or its folder', () => {
    const dir = folder();
    expect(noteOpenedFile(path.join(dir, 'notes.md'))).toBe(path.join(dir, 'notes.md'));
    expect(isOpenedFile(path.join(dir, 'notes.md'))).toBe(true);
    expect(isOpenedFile(path.join(dir, 'beside.md'))).toBe(false);
    expect(isOpenedFile(dir)).toBe(false);
  });

  it('refuses folders, missing files and relative paths', () => {
    const dir = folder();
    expect(noteOpenedFile(dir)).toBeNull();
    expect(noteOpenedFile(path.join(dir, 'missing.md'))).toBeNull();
    expect(noteOpenedFile('notes.md')).toBeNull();
    expect(isOpenedFile('notes.md')).toBe(false);
  });

  it('matches through a symlink to the opened file, and not a link planted to another', () => {
    const dir = folder();
    noteOpenedFile(path.join(dir, 'notes.md'));
    fs.symlinkSync(path.join(dir, 'notes.md'), path.join(dir, 'alias.md'));
    fs.symlinkSync(path.join(dir, 'beside.md'), path.join(dir, 'planted.md'));
    expect(isOpenedFile(path.join(dir, 'alias.md'))).toBe(true);
    expect(isOpenedFile(path.join(dir, 'planted.md'))).toBe(false);
  });
});
