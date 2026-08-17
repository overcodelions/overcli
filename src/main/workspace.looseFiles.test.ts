import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
}));

import { isSyntheticRootPath, looseSyntheticRootFiles } from './workspace';

const RUN_START = Date.UTC(2026, 7, 17, 6, 0, 0);

/// A coordinator root as the runtime builds it: one symlink per member
/// project plus the three context files.
function coordinatorRoot(id = 'run-1'): string {
  const root = path.join(userDataDir, 'coordinators', id);
  fs.mkdirSync(root, { recursive: true });
  const member = path.join(userDataDir, 'checkouts', 'gitrepo');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'index.ts'), 'export const a = 1;');
  fs.symlinkSync(member, path.join(root, 'gitrepo'), 'dir');
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    fs.writeFileSync(path.join(root, name), '# workspace context');
  }
  return root;
}

function writeAt(full: string, body: string, at: number): void {
  fs.writeFileSync(full, body);
  fs.utimesSync(full, new Date(at), new Date(at));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-loose-files-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('looseSyntheticRootFiles', () => {
  it('finds the file a run wrote at its working root', () => {
    const root = coordinatorRoot();
    writeAt(path.join(root, 'dashboard.html'), '<html></html>', RUN_START + 1000);
    expect(looseSyntheticRootFiles(root, { since: RUN_START }).map((f) => f.name)).toEqual([
      'dashboard.html',
    ]);
  });

  it('leaves the root’s own furniture alone', () => {
    const root = coordinatorRoot();
    writeAt(path.join(root, '.DS_Store'), 'x', RUN_START + 1000);
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      fs.utimesSync(path.join(root, name), new Date(RUN_START + 1000), new Date(RUN_START + 1000));
    }
    expect(looseSyntheticRootFiles(root, { since: RUN_START })).toEqual([]);
  });

  it('does not follow the member symlinks into real project source', () => {
    const root = coordinatorRoot();
    writeAt(path.join(root, 'report.md'), '# report', RUN_START + 1000);
    const names = looseSyntheticRootFiles(root, { since: RUN_START }).map((f) => f.name);
    expect(names).toEqual(['report.md']);
    expect(names).not.toContain('gitrepo');
  });

  it('ignores what an earlier run left in a workspace root that outlives it', () => {
    const root = path.join(userDataDir, 'workspaces', 'ws-1');
    fs.mkdirSync(root, { recursive: true });
    writeAt(path.join(root, 'yesterday.html'), 'old', RUN_START - 86_400_000);
    writeAt(path.join(root, 'today.html'), 'new', RUN_START + 1000);
    expect(looseSyntheticRootFiles(root, { since: RUN_START }).map((f) => f.name)).toEqual([
      'today.html',
    ]);
  });

  it('refuses to sweep anything that is not a root Overcli made', () => {
    const project = path.join(userDataDir, 'checkouts', 'gitrepo');
    fs.mkdirSync(project, { recursive: true });
    writeAt(path.join(project, 'README.md'), '# real source', RUN_START + 1000);
    expect(looseSyntheticRootFiles(project, { since: RUN_START })).toEqual([]);
    // Nor a subdirectory of one, which is a checkout rather than a root.
    const nested = path.join(userDataDir, 'coordinators', 'run-1', 'gitrepo');
    expect(looseSyntheticRootFiles(nested, { since: RUN_START })).toEqual([]);
  });

  it('is empty for a root that no longer exists', () => {
    expect(looseSyntheticRootFiles(path.join(userDataDir, 'coordinators', 'gone'))).toEqual([]);
  });
});

describe('isSyntheticRootPath', () => {
  it('matches a workspace or coordinator root Overcli created', () => {
    expect(isSyntheticRootPath(path.join(userDataDir, 'coordinators', 'run-1'))).toBe(true);
    expect(isSyntheticRootPath(path.join(userDataDir, 'workspaces', 'ws-1'))).toBe(true);
  });

  it('matches a stored path whose userData casing drifted', () => {
    // Runs recorded `…/Application Support/overcli/…` while userData reports
    // `…/Overcli`; on a case-insensitive volume those are one directory.
    fs.mkdirSync(path.join(userDataDir, 'coordinators', 'run-1'), { recursive: true });
    const drifted = path.join(userDataDir.toUpperCase(), 'coordinators', 'run-1');
    expect(isSyntheticRootPath(drifted)).toBe(process.platform !== 'linux');
  });

  it('rejects a real project path and anything empty', () => {
    expect(isSyntheticRootPath('/Users/someone/git/project')).toBe(false);
    expect(isSyntheticRootPath('')).toBe(false);
  });
});
