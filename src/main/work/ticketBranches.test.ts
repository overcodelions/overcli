import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchNamesTicket, ticketBranches } from './ticketBranches';

describe('branchNamesTicket', () => {
  it('matches the key as a whole token, in any case', () => {
    expect(branchNamesTicket('feature/ACME-12-fix', 'ACME-12')).toBe(true);
    expect(branchNamesTicket('feature/acme-12', 'ACME-12')).toBe(true);
    expect(branchNamesTicket('ACME-12', 'ACME-12')).toBe(true);
    expect(branchNamesTicket('feature/ACME-123', 'ACME-12')).toBe(false);
    expect(branchNamesTicket('feature/XACME-12', 'ACME-12')).toBe(false);
  });
});

describe('ticketBranches', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-ticket-branches-'));
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
    git(['init', '-b', 'main']);
    git(['commit', '--allow-empty', '-m', 'initial']);
    git(['branch', 'feature/ACME-7-login']);
    git(['branch', 'feature/ACME-70']);
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('finds the branches named for each key', async () => {
    const found = await ticketBranches([repo], ['acme-7', 'ACME-99']);
    expect(found['ACME-7']).toEqual([{ repo, branch: 'feature/ACME-7-login' }]);
    expect(found['ACME-99']).toBeUndefined();
  });
});
