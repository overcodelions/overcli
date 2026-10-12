import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serviceFileMatcher, watchRoots, watchServiceFiles } from './fileWatch';

describe('service file globs', () => {
  const checkout = path.resolve('/code/acme-api');

  it("watches each glob's fixed prefix once, not every folder under the checkout", () => {
    expect(watchRoots(checkout, ['src/**/*.ts', 'src/main/**/*.java', 'config/app.yml', '*.json'])).toEqual([
      checkout,
    ]);
    expect(watchRoots(checkout, ['src/**/*.ts', 'src/main/**/*.java', 'config/app.yml'])).toEqual([
      path.join(checkout, 'config', 'app.yml'),
      path.join(checkout, 'src'),
    ]);
  });

  it('matches only the files a service opted into, and never inside ignored folders', () => {
    const matches = serviceFileMatcher(checkout, ['src/**/*.ts', 'config/app.yml', '.env']);
    expect(matches(path.join(checkout, 'src', 'server', 'index.ts'))).toBe(true);
    expect(matches(path.join(checkout, 'config', 'app.yml'))).toBe(true);
    expect(matches(path.join(checkout, '.env'))).toBe(true);
    expect(matches(path.join(checkout, 'src', 'readme.md'))).toBe(false);
    expect(matches(path.join(checkout, 'src', 'node_modules', 'dep', 'index.ts'))).toBe(false);
    expect(matches(path.join(checkout, 'src', 'dist', 'index.ts'))).toBe(false);
    expect(matches(path.resolve('/code/other', 'src', 'index.ts'))).toBe(false);
  });
});

describe('watchServiceFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-filewatch-')));
    fs.mkdirSync(path.join(dir, 'src', 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports a change to a matching file and ignores the rest', async () => {
    const seen: string[] = [];
    const watcher = watchServiceFiles(dir, ['src/**/*.ts'], (rel) => seen.push(rel));
    try {
      // Give the watcher a moment to be ready before writing.
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(dir, 'src', 'notes.md'), 'no');
      fs.writeFileSync(path.join(dir, 'src', 'node_modules', 'dep.ts'), 'no');
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'yes');
      await vi.waitFor(() => expect(seen).toContain(path.join('src', 'app.ts')), { timeout: 4000 });
      expect(seen).toEqual([path.join('src', 'app.ts')]);
    } finally {
      await watcher.close();
    }
  });
});
