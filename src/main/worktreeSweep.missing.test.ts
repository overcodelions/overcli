import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missingManagedWorktrees } from './worktreeSweep';

let root: string;
let home: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'overcli-missing-')));
  home = process.env.HOME;
  process.env.HOME = root;
});
afterEach(() => {
  process.env.HOME = home;
  rmSync(root, { recursive: true, force: true });
});

describe('missingManagedWorktrees', () => {
  it('reports only managed trees that are gone, once each', () => {
    const here = join(root, '.overcli/worktrees/acme/here');
    const gone = join(root, '.overcli/worktrees/acme/gone');
    mkdirSync(here, { recursive: true });
    const outside = join(root, 'elsewhere/gone');
    expect(missingManagedWorktrees([here, gone, gone, outside])).toEqual([gone]);
  });
});
