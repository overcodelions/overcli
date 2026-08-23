import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyIntoProject, createEverydayProject, everydayProjectsRoot, folderNameFor } from './everydayProject';
import { looksLikeEverydayProjectPath } from '../shared/everydayProjects';

describe('everydayProject', () => {
  it('makes folder-safe names', () => {
    expect(folderNameFor('Q3 Marketing / Copy!')).toBe('Q3 Marketing Copy');
    expect(folderNameFor('###')).toBe('New project');
  });

  it('uses the Overcli Projects root', () => {
    expect(everydayProjectsRoot().endsWith('Overcli Projects')).toBe(true);
  });
});

describe('createEverydayProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-everyday-home-'));
    // `everydayProjectsRoot` prefers `~/Documents` but falls back to the
    // home dir itself when it doesn't exist — the fixture doesn't need it.
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    return home;
  }

  it('scaffolds the folder and a BRIEF.md carrying the title and goal', () => {
    const home = fakeHome();

    const res = createEverydayProject({ title: 'Marketing copy review', goal: 'Check tone and claims.' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe(path.join(home, 'Overcli Projects', 'Marketing copy review'));
    // Deliberately flat: no `inbox/`, no `output/`. The undo history is what
    // distinguishes what the agent made from what the user supplied.
    expect(fs.readdirSync(res.path)).toEqual(['BRIEF.md']);
    const brief = fs.readFileSync(path.join(res.path, 'BRIEF.md'), 'utf-8');
    expect(brief).toContain('# Marketing copy review');
    expect(brief).toContain('Check tone and claims.');
  });

  it('numbers a second project rather than colliding with the first', () => {
    fakeHome();

    const first = createEverydayProject({ title: 'Weekly report', goal: 'a' });
    const second = createEverydayProject({ title: 'Weekly report', goal: 'b' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.path).not.toBe(second.path);
    expect(second.path.endsWith('Weekly report 2')).toBe(true);
  });

  it('trims the goal before writing it into BRIEF.md', () => {
    fakeHome();

    const res = createEverydayProject({ title: 'Trim test', goal: '  spaced out  ' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const brief = fs.readFileSync(path.join(res.path, 'BRIEF.md'), 'utf-8');
    expect(brief).toContain('## What I want\n\nspaced out\n');
  });
});

describe('copyIntoProject', () => {
  function tempProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-copy-into-'));
  }

  const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');

  it('writes dropped bytes straight into the project folder', () => {
    const dir = tempProject();
    const res = copyIntoProject({
      projectPath: dir,
      files: [{ name: 'brief.txt', dataBase64: b64('hello') }],
    });

    expect(res).toEqual({ ok: true, written: 1 });
    expect(fs.readFileSync(path.join(dir, 'brief.txt'), 'utf-8')).toBe('hello');
  });

  it('numbers a colliding filename rather than overwriting the user\'s file', () => {
    const dir = tempProject();
    copyIntoProject({ projectPath: dir, files: [{ name: 'report.csv', dataBase64: b64('first') }] });
    copyIntoProject({ projectPath: dir, files: [{ name: 'report.csv', dataBase64: b64('second') }] });

    expect(fs.readFileSync(path.join(dir, 'report.csv'), 'utf-8')).toBe('first');
    expect(fs.readFileSync(path.join(dir, 'report 2.csv'), 'utf-8')).toBe('second');
  });

  it('cannot be walked out of the project by a hostile filename', () => {
    const dir = tempProject();
    const res = copyIntoProject({
      projectPath: dir,
      files: [{ name: '../../../evil.txt', dataBase64: b64('nope') }],
    });

    expect(res.ok).toBe(true);
    // Reduced to its basename, so it lands inside the project either way.
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(dir), 'evil.txt'))).toBe(false);
  });

  it('reports when there is nothing usable to write', () => {
    const dir = tempProject();
    expect(copyIntoProject({ projectPath: dir, files: [] }).ok).toBe(false);
    expect(copyIntoProject({ projectPath: dir, files: [{ name: '...', dataBase64: '' }] }).ok).toBe(false);
  });
});

describe('looksLikeEverydayProjectPath', () => {
  it('recognises a project scaffolded before the flag existed', () => {
    expect(looksLikeEverydayProjectPath('/Users/me/Documents/Overcli Projects/Marketing101')).toBe(true);
  });

  it('does not claim an ordinary folder', () => {
    expect(looksLikeEverydayProjectPath('/Users/me/git-services/overcli')).toBe(false);
    expect(looksLikeEverydayProjectPath('')).toBe(false);
  });
});
