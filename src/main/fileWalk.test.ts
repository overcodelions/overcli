import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFileEntriesAsync, listFileEntriesSync, type WalkEntry } from './fileWalk';

/// A tree with everything the walk has an opinion about: nesting, a skipped
/// build directory, a symlinked project (the workspace shape), a symlink to
/// a file, and a broken link.
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-walk-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-walk-member-'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'readme');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'nested.ts'), 'deep');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'skipped');
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'skipped');
  fs.writeFileSync(path.join(project, 'member.ts'), 'member file');
  fs.symlinkSync(project, path.join(root, 'member'), 'dir');
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'README.link.md'));
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'broken.link'));
  return root;
}

function names(entries: WalkEntry[], root: string): string[] {
  return entries.map((e) => path.relative(root, e.path)).sort();
}

describe('project walk', () => {
  it('lists sources, follows symlinked projects, and skips build output', async () => {
    const root = fixture();
    const listed = names(listFileEntriesSync(root), root);
    expect(listed).toEqual([
      'README.link.md',
      'README.md',
      'member/member.ts',
      'src/deep/nested.ts',
      'src/index.ts',
    ]);
    // Broken links and skipped directories contribute nothing.
    expect(listed.some((n) => n.includes('node_modules'))).toBe(false);
    expect(listed.some((n) => n.includes('dist'))).toBe(false);
    expect(listed).not.toContain('broken.link');
    expect(names(await listFileEntriesAsync(root), root)).toEqual(listed);
  });

  it('reports the same sizes from either walk', async () => {
    const root = fixture();
    const sync = listFileEntriesSync(root).sort((a, b) => a.path.localeCompare(b.path));
    const async_ = (await listFileEntriesAsync(root)).sort((a, b) => a.path.localeCompare(b.path));
    expect(async_).toEqual(sync);
    expect(sync.find((e) => e.path.endsWith('README.md'))?.sizeBytes).toBe(6);
  });

  it('agrees with the sync walk on a real repo', async () => {
    const repo = path.resolve(__dirname, '..', '..');
    const sync = names(listFileEntriesSync(repo), repo);
    const async_ = names(await listFileEntriesAsync(repo), repo);
    expect(async_).toEqual(sync);
    expect(sync.length).toBeGreaterThan(50);
  });

  it('returns nothing for a root that does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'overcli-walk-missing');
    expect(listFileEntriesSync(missing)).toEqual([]);
    expect(await listFileEntriesAsync(missing)).toEqual([]);
  });

  it('terminates on a symlink cycle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-walk-loop-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', 'file.ts'), 'x');
    // a/loop -> a, so the walk can descend forever if nothing bounds it.
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a', 'loop'), 'dir');
    expect(listFileEntriesSync(root).length).toBeGreaterThan(0);
    expect((await listFileEntriesAsync(root)).length).toBeGreaterThan(0);
  }, 30_000);
});
