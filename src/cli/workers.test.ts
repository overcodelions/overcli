// `overcli workers audit`, end to end through the real store and real git:
// a temp repo, a temp state directory holding orchestration JSON exactly as
// the app writes it, and the command's own exit code and output.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Orchestration } from '../shared/flows/orchestration';
import { parseArgs } from './args';
import { main } from './index';
import { EXIT } from './run';
import { resolveAuditStateDir, workersAuditCommand } from './workers';

let root: string;
let repo: string;
let mergedSha: string;
let strandedSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(name: string, msg: string): string {
  fs.writeFileSync(path.join(repo, name), `${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

function stateDirWith(batches: Orchestration[]): string {
  const dir = fs.mkdtempSync(path.join(root, 'state-'));
  fs.mkdirSync(path.join(dir, 'orchestrations'));
  for (const b of batches) {
    fs.writeFileSync(path.join(dir, 'orchestrations', `${b.id}.json`), JSON.stringify(b));
  }
  return dir;
}

function batch(id: string, headSha: string | undefined, kind: 'worker' | 'schedule' = 'worker'): Orchestration {
  return {
    id,
    title: `Shift ${id}`,
    projectPath: repo,
    baseBranch: 'master',
    maxConcurrent: 1,
    createdAt: Date.UTC(2026, 9, 14),
    completedAt: Date.UTC(2026, 9, 14),
    origin:
      kind === 'worker'
        ? { kind: 'worker', workerId: 'w1', workerName: 'Prometheus' }
        : { kind: 'schedule', scheduleId: 's1', scheduleName: 'Nightly' },
    items: [
      {
        candidate: { id: `${id}-c`, title: `Work from ${id}`, prompt: 'p' },
        flowId: 'flow',
        status: 'done',
        headSha,
        branchName: `prometheus/${id}`,
        finishedAt: Date.UTC(2026, 9, 14),
      },
    ],
  };
}

function capture() {
  const io = { stdout: '', stderr: '' };
  return {
    io,
    sink: { out: (t: string) => (io.stdout += t), err: (t: string) => (io.stderr += t) },
  };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-workers-audit-'));
  repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  commit('base.txt', 'base');
  git(repo, 'checkout', '-qb', 'prometheus/merged');
  mergedSha = commit('merged.txt', 'merged shift');
  git(repo, 'checkout', '-q', 'master');
  git(repo, 'merge', '-q', '--ff-only', 'prometheus/merged');
  git(repo, 'checkout', '-qb', 'prometheus/stranded');
  strandedSha = commit('stranded.txt', 'stranded shift');
  git(repo, 'checkout', '-q', 'master');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseArgs: workers audit', () => {
  it('parses the subcommand and its flags', () => {
    const r = parseArgs(['workers', 'audit', '--json', '--state-dir=/x']);
    expect(r).toEqual({ ok: true, args: { command: 'workers', workers: { json: true, stateDir: '/x' }, warnings: [] } });
  });

  it('refuses a missing or unknown subcommand and run-only flags', () => {
    expect(parseArgs(['workers']).ok).toBe(false);
    expect(parseArgs(['workers', 'list']).ok).toBe(false);
    const r = parseArgs(['workers', 'audit', '--permissions', 'deny']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not an audit option/);
  });
});

describe('resolveAuditStateDir', () => {
  const home = '/home/u';
  it('prefers --state-dir, then $OVERCLI_HOME', () => {
    expect(resolveAuditStateDir('/flag', { OVERCLI_HOME: '/env' }, 'darwin', home, () => true)).toBe('/flag');
    expect(resolveAuditStateDir(undefined, { OVERCLI_HOME: '/env' }, 'darwin', home, () => true)).toBe('/env');
  });

  it("falls to the desktop app's data directory when it holds batches", () => {
    expect(resolveAuditStateDir(undefined, {}, 'darwin', home, () => true)).toBe(
      '/home/u/Library/Application Support/Overcli',
    );
    expect(resolveAuditStateDir(undefined, { XDG_CONFIG_HOME: '/cfg' }, 'linux', home, () => true)).toBe(
      '/cfg/Overcli',
    );
  });

  it('falls back to the headless default when the app has no batches', () => {
    expect(resolveAuditStateDir(undefined, {}, 'darwin', home, () => false)).not.toContain('Application Support');
  });
});

describe('workersAuditCommand (real store, real git)', () => {
  it('reports the stranded landing, not the merged one or the scheduled one, and exits NEEDS_HUMAN', async () => {
    const dir = stateDirWith([
      batch('merged', mergedSha),
      batch('stranded', strandedSha),
      batch('nosha', undefined),
      batch('scheduled', strandedSha, 'schedule'),
    ]);
    const { io, sink } = capture();
    const code = await workersAuditCommand({ stateDir: dir, json: false }, sink);
    expect(code).toBe(EXIT.NEEDS_HUMAN);
    expect(io.stdout).toContain('1 stranded landing(s)');
    expect(io.stdout).toContain('Work from stranded');
    expect(io.stdout).toContain(strandedSha.slice(0, 10));
    expect(io.stdout).toContain('prometheus/stranded');
    expect(io.stdout).not.toContain('Work from merged');
    expect(io.stdout).toContain('merged 1');
    expect(io.stdout).toContain('skipped 1');
  });

  it('exits OK when every landing is merged', async () => {
    const dir = stateDirWith([batch('merged', mergedSha)]);
    const { io, sink } = capture();
    expect(await workersAuditCommand({ stateDir: dir, json: false }, sink)).toBe(EXIT.OK);
    expect(io.stdout).toContain('No stranded worker landings.');
  });

  it('emits one parseable JSON object under --json', async () => {
    const dir = stateDirWith([batch('stranded', strandedSha)]);
    const { io, sink } = capture();
    expect(await workersAuditCommand({ stateDir: dir, json: true }, sink)).toBe(EXIT.NEEDS_HUMAN);
    const parsed = JSON.parse(io.stdout);
    expect(parsed.stranded).toHaveLength(1);
    expect(parsed.stranded[0]).toMatchObject({
      workerName: 'Prometheus',
      batchTitle: 'Shift stranded',
      itemTitle: 'Work from stranded',
      headSha: strandedSha,
      branchName: 'prometheus/stranded',
      projectPath: repo,
      landability: 'clean',
    });
  });

  it('refuses a state directory with no batches instead of calling it clean', async () => {
    const empty = fs.mkdtempSync(path.join(root, 'empty-'));
    const { io, sink } = capture();
    expect(await workersAuditCommand({ stateDir: empty, json: false }, sink)).toBe(EXIT.BAD_INPUT);
    expect(io.stderr).toContain('no orchestrations/');
  });

  it('is reachable through main()', async () => {
    const dir = stateDirWith([batch('stranded', strandedSha)]);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['workers', 'audit', '--state-dir', dir, '--json'])).toBe(EXIT.NEEDS_HUMAN);
    } finally {
      write.mockRestore();
    }
  });
});
