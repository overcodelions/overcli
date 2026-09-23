import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChildRepos, inspectFolder } from './childRepos';

describe('findChildRepos', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'child-repos-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const repo = (name: string, gitAsFile = false) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (gitAsFile) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere');
    else fs.mkdirSync(path.join(dir, '.git'));
    return dir;
  };

  it('lists the repos directly inside a folder, sorted', () => {
    repo('acme-web');
    repo('acme-api');
    fs.mkdirSync(path.join(root, 'notes'));
    expect(findChildRepos(root)).toEqual([
      path.join(root, 'acme-api'),
      path.join(root, 'acme-web'),
    ]);
  });

  it('counts a worktree-style .git file as a repo', () => {
    repo('acme-web', true);
    expect(findChildRepos(root)).toEqual([path.join(root, 'acme-web')]);
  });

  it('returns nothing when the folder is itself a repo', () => {
    fs.mkdirSync(path.join(root, '.git'));
    repo('packages/acme-ui');
    repo('acme-web');
    expect(findChildRepos(root)).toEqual([]);
  });

  it('does not look more than one level down', () => {
    repo('group/acme-web');
    repo('group/acme-api');
    expect(findChildRepos(root)).toEqual([]);
  });

  it('skips hidden folders and survives a missing directory', () => {
    repo('.cache');
    expect(findChildRepos(root)).toEqual([]);
    expect(findChildRepos(path.join(root, 'gone'))).toEqual([]);
  });
});

describe('inspectFolder', () => {
  let root: string;
  const isDoc = (f: string) => /\.(md|docx|pdf|xlsx|txt)$/i.test(f);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-folder-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = (rel: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  };

  it('calls a repo a repo', () => {
    fs.mkdirSync(path.join(root, '.git'));
    file('notes.md');
    expect(inspectFolder(root, isDoc)).toEqual({ kind: 'repo' });
  });

  it('offers a folder of repos', () => {
    fs.mkdirSync(path.join(root, 'acme-web', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'acme-api', '.git'), { recursive: true });
    expect(inspectFolder(root, isDoc)).toEqual({
      kind: 'repos',
      repoPaths: [path.join(root, 'acme-api'), path.join(root, 'acme-web')],
    });
  });

  it('recognises a folder that is mostly documents, one level down too', () => {
    file('Q3 brief.docx');
    file('research/interviews.pdf');
    file('research/summary.md');
    file('logo.png');
    expect(inspectFolder(root, isDoc)).toEqual({ kind: 'documents' });
  });

  it('treats unversioned code as other, even beside documents', () => {
    file('package.json');
    file('README.md');
    file('CHANGELOG.md');
    expect(inspectFolder(root, isDoc)).toEqual({ kind: 'other' });
  });

  it('treats an empty or mixed folder as other', () => {
    expect(inspectFolder(root, isDoc)).toEqual({ kind: 'other' });
    file('a.md');
    file('b.png');
    file('c.jpg');
    expect(inspectFolder(root, isDoc)).toEqual({ kind: 'other' });
  });
});
