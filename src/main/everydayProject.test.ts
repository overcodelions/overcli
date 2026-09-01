import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROJECT_FILE_BYTES } from '../shared/fileLimits';
import {
  copyIntoProject,
  createEverydayProject,
  EVERYDAY_MARKER_FILE,
  everydayProjectsRoot,
  folderNameFor,
  hasEverydayMarker,
  setEverydayMarker,
  syncProjectMarkers,
} from './everydayProject';
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
    // Flat, plus the marker that lets the folder recognise itself elsewhere.
    expect(fs.readdirSync(res.path).sort()).toEqual(['.overcli-project.json', 'BRIEF.md']);
    expect(hasEverydayMarker(res.path)).toBe(true);
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

    expect(res).toEqual({ ok: true, written: 1, rejections: [] });
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

  it('copies from a source path without the bytes passing through IPC', () => {
    const dir = tempProject();
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-src-')), 'deck.pptx');
    fs.writeFileSync(src, 'slides');

    const res = copyIntoProject({
      projectPath: dir,
      files: [{ name: 'deck.pptx', sourcePath: src }],
    });

    expect(res).toEqual({ ok: true, written: 1, rejections: [] });
    expect(fs.readFileSync(path.join(dir, 'deck.pptx'), 'utf-8')).toBe('slides');
    // The source is a copy, not a move: it is the user's own file.
    expect(fs.existsSync(src)).toBe(true);
  });

  it('re-checks the size cap on a source path it was handed', () => {
    const dir = tempProject();
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-src-')), 'huge.bin');
    fs.writeFileSync(src, Buffer.alloc(1024));
    const realStat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      const stat = realStat(p as never, ...(rest as []));
      if (p === src) Object.defineProperty(stat, 'size', { value: MAX_PROJECT_FILE_BYTES + 1 });
      return stat;
    }) as typeof fs.statSync);

    const res = copyIntoProject({
      projectPath: dir,
      files: [{ name: 'ok.txt', dataBase64: b64('fine') }, { name: 'huge.bin', sourcePath: src }],
    });
    spy.mockRestore();

    expect(res.ok).toBe(true);
    expect(res.ok && res.written).toBe(1);
    expect(res.ok && res.rejections[0]).toContain('max is 50 MB');
    expect(fs.existsSync(path.join(dir, 'huge.bin'))).toBe(false);
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

// The marker is what makes a folder recognise itself somewhere the app's own
// store has never seen it: a reinstall, a second machine, a shared folder.
describe('everyday project marker', () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-marker-'));
  }

  it('reports no marker for an ordinary folder, and never throws on junk', () => {
    const dir = tempDir();
    expect(hasEverydayMarker(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, EVERYDAY_MARKER_FILE), 'not json at all');
    expect(hasEverydayMarker(dir)).toBe(false);
  });

  it('adopts a folder that carries a marker, even with no flag in the store', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, EVERYDAY_MARKER_FILE),
      JSON.stringify({ kind: 'everyday', version: 1 }),
    );

    expect(syncProjectMarkers([{ path: dir }])).toEqual({ [dir]: true });
  });

  it('back-fills a marker for a project the store already vouches for', () => {
    const dir = tempDir();

    expect(syncProjectMarkers([{ path: dir, everyday: true }])).toEqual({ [dir]: true });
    expect(hasEverydayMarker(dir)).toBe(true);
  });

  it('never invents everyday-ness for a folder that was not already one', () => {
    const dir = tempDir();

    expect(syncProjectMarkers([{ path: dir, everyday: false }])).toEqual({ [dir]: false });
    expect(fs.existsSync(path.join(dir, EVERYDAY_MARKER_FILE))).toBe(false);
  });
});

describe('setEverydayMarker', () => {
  function tempFolder(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-convert-'));
  }

  it('marks a plain folder, and unmarks it again', () => {
    const dir = tempFolder();

    expect(setEverydayMarker(dir, true)).toEqual({ ok: true });
    expect(hasEverydayMarker(dir)).toBe(true);

    expect(setEverydayMarker(dir, false)).toEqual({ ok: true });
    expect(hasEverydayMarker(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, EVERYDAY_MARKER_FILE))).toBe(false);
  });

  // Unmarking twice happens whenever a revert is retried, and there is
  // nothing wrong with a folder that is already not an everyday project.
  it('treats an absent marker as already cleared', () => {
    expect(setEverydayMarker(tempFolder(), false)).toEqual({ ok: true });
  });

  // Unlike `writeEverydayMarker`, this one is the operation the user asked
  // for — a failure has to reach them rather than be swallowed.
  it('reports a write it could not do', () => {
    const res = setEverydayMarker(path.join(os.tmpdir(), 'overcli-nope-does-not-exist'), true);
    expect(res.ok).toBe(false);
  });

  it('leaves the folder contents alone', () => {
    const dir = tempFolder();
    fs.writeFileSync(path.join(dir, 'notes.md'), '# hi\n', 'utf-8');

    setEverydayMarker(dir, true);
    setEverydayMarker(dir, false);

    expect(fs.readdirSync(dir)).toEqual(['notes.md']);
  });
});
