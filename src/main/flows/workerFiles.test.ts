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

import {
  archiveWorkerFiles,
  clearWorkerFiles,
  deleteWorkerFile,
  deliverableFiles,
  ensureWorkerFilesDir,
  deliverableName,
  fileWorkerDeliverable,
  listWorkerFiles,
  readWorkerFile,
  workerFilesDir,
} from './workerFiles';

const WORKER = 'worker-1';
// 2026-08-16 14:31 local — the stamp is local time by design.
const AT = new Date(2026, 7, 16, 14, 31, 2).getTime();

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-worker-files-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('deliverableName', () => {
  it('leads with the date so the directory sorts chronologically', () => {
    expect(
      deliverableName({ task: 'errand', label: '[Errand] x', title: 'Why is CI slow', at: AT }),
    ).toBe('2026-08-16-1431-errand-why-is-ci-slow');
  });

  it('keeps a shift’s number and drops the worker’s own name', () => {
    expect(
      deliverableName({ task: 'shift', label: '[Shift 7] Warden', title: 'Add tests', at: AT }),
    ).toBe('2026-08-16-1431-shift-7-add-tests');
  });

  it('cuts a long subject at a word boundary, never mid-word', () => {
    const name = deliverableName({
      task: 'errand',
      label: '[Errand] x',
      title: 'Generate and report parser test coverage across every module',
      at: AT,
    });
    // The old hard slice cut this at 40 chars — "…-report-parser-test-c",
    // which reads as a typo rather than an abbreviation.
    expect(name).toBe('2026-08-16-1431-errand-generate-and-report-parser-test-coverage-across');
    expect(name.endsWith('-')).toBe(false);
  });

  it('keeps a subject that fits whole', () => {
    expect(
      deliverableName({
        task: 'errand',
        label: '[Errand] x',
        title: 'Generate and report parser test coverage',
        at: AT,
      }),
    ).toBe('2026-08-16-1431-errand-generate-and-report-parser-test-coverage');
  });
});

describe('fileWorkerDeliverable', () => {
  const job = { workerId: WORKER, task: 'errand' as const, label: '[Errand] x', title: 'Coverage', at: AT };

  it('files one artifact as a file and several as a folder', () => {
    fileWorkerDeliverable({ ...job, artifacts: [{ name: 'report.md', body: 'one' }] });
    fileWorkerDeliverable({
      ...job,
      title: 'Other',
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'raw_test_output.md', body: 'b' },
      ],
    });
    const names = listWorkerFiles(WORKER).map((f) => f.name);
    expect(names).toContain('2026-08-16-1431-errand-coverage.md');
    expect(names).toContain('2026-08-16-1431-errand-other/report.md');
    expect(names).toContain('2026-08-16-1431-errand-other/raw_test_output.md');
  });

  it('never overwrites — the journal fold re-files on every update', () => {
    fileWorkerDeliverable({ ...job, artifacts: [{ name: 'report.md', body: 'first' }] });
    const second = fileWorkerDeliverable({ ...job, artifacts: [{ name: 'report.md', body: 'second' }] });
    expect(second.written).toBe(false);
    const file = path.join(workerFilesDir(WORKER), '2026-08-16-1431-errand-coverage.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe('first');
  });

  it('keeps two jobs that finish in the same minute apart', () => {
    fileWorkerDeliverable({ ...job, artifacts: [{ name: 'r.md', body: 'a' }] });
    fileWorkerDeliverable({ ...job, title: 'Something else', artifacts: [{ name: 'r.md', body: 'b' }] });
    const names = fs.readdirSync(workerFilesDir(WORKER)).sort();
    expect(names).toEqual([
      '2026-08-16-1431-errand-coverage.md',
      '2026-08-16-1431-errand-something-else.md',
    ]);
  });

  it('does not let a shorter job name swallow a longer, unrelated one at a mid-word overlap', () => {
    // "Cover" and "Coverage" are two DIFFERENT jobs filed in the same minute
    // whose slugs happen to share a mid-word prefix — the old unconditional
    // `startsWith` check merged these; the dash-boundary rule must not.
    fileWorkerDeliverable({ ...job, title: 'Cover', artifacts: [{ name: 'r.md', body: 'a' }] });
    fileWorkerDeliverable({
      ...job,
      title: 'Coverage',
      artifacts: [{ name: 'r.md', body: 'b' }],
    });
    const names = fs.readdirSync(workerFilesDir(WORKER)).sort();
    expect(names).toEqual([
      '2026-08-16-1431-errand-cover.md',
      '2026-08-16-1431-errand-coverage.md',
    ]);
    expect(
      fs.readFileSync(path.join(workerFilesDir(WORKER), '2026-08-16-1431-errand-cover.md'), 'utf-8'),
    ).toBe('a');
    expect(
      fs.readFileSync(path.join(workerFilesDir(WORKER), '2026-08-16-1431-errand-coverage.md'), 'utf-8'),
    ).toBe('b');
  });

  it('reuses the folder a job is already filed under when the name was truncated', () => {
    // Stand in for a job filed before the slug was cut at a word boundary. The
    // truncation lands on a dash, matching what `slug()` actually produces —
    // a mid-word cut is a different (colliding) job, not this one shortened.
    const legacy = path.join(workerFilesDir(WORKER), '2026-08-16-1431-errand-coverage');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'report.md'), 'a');

    fileWorkerDeliverable({
      ...job,
      title: 'Coverage Report',
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'notes.md', body: 'b' },
      ],
    });

    const dirs = fs.readdirSync(workerFilesDir(WORKER));
    // One job, one folder: a second name for the same work would show the
    // same errand twice in the Files tab.
    expect(dirs).toEqual(['2026-08-16-1431-errand-coverage']);
    expect(fs.readdirSync(legacy).sort()).toEqual(['notes.md', 'report.md']);
  });

  it('does not re-create an archived job at the top level on a re-fold', () => {
    fileWorkerDeliverable({
      ...job,
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'verification.md', body: 'b' },
      ],
    });
    const dir = workerFilesDir(WORKER);
    const archived = path.join(dir, 'archive', '2026-08-16-1431-errand-coverage');
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.renameSync(path.join(dir, '2026-08-16-1431-errand-coverage'), archived);

    // Simulates syncOrchestration re-folding a `done` item it has already
    // filed once — idempotent by filename, and the archived copy counts.
    fileWorkerDeliverable({
      ...job,
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'verification.md', body: 'b' },
      ],
    });

    expect(fs.readdirSync(dir).sort()).toEqual(['archive']);
    expect(fs.readdirSync(archived).sort()).toEqual(['report.md', 'verification.md']);
  });
});

describe('deliverableFiles', () => {
  const job = { workerId: WORKER, task: 'errand' as const, label: '[Errand] x', title: 'Coverage', at: AT };

  it('finds every file of a multi-artifact job', () => {
    fileWorkerDeliverable({
      ...job,
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'verification.md', body: 'b' },
      ],
    });
    const found = deliverableFiles(job);
    expect(found.map((f) => f.name)).toEqual([
      '2026-08-16-1431-errand-coverage/report.md',
      '2026-08-16-1431-errand-coverage/verification.md',
    ]);
    expect(found.every((f) => fs.existsSync(f.path))).toBe(true);
  });

  it('finds a single-artifact job filed as one file', () => {
    fileWorkerDeliverable({ ...job, artifacts: [{ name: 'report.md', body: 'a' }] });
    expect(deliverableFiles(job).map((f) => f.name)).toEqual([
      '2026-08-16-1431-errand-coverage.md',
    ]);
  });

  it('finds a job filed under an older, shorter name', () => {
    // Same dash-boundary truncation as above — a legacy shorter slug, not a
    // different job that happens to share a prefix.
    const legacy = path.join(workerFilesDir(WORKER), '2026-08-16-1431-errand-coverage');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'report.md'), 'a');
    expect(deliverableFiles({ ...job, title: 'Coverage Report' })).toHaveLength(1);
  });

  it('returns nothing when the job was never filed, rather than a dead link', () => {
    expect(deliverableFiles({ ...job, at: AT + 60 * 60_000 })).toEqual([]);
  });
});

describe('deleteWorkerFile', () => {
  const job = { workerId: WORKER, task: 'errand' as const, label: '[Errand] x', title: 'Coverage', at: AT };

  it('deletes a whole job folder', () => {
    fileWorkerDeliverable({
      ...job,
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'raw.md', body: 'b' },
      ],
    });
    const res = deleteWorkerFile(WORKER, '2026-08-16-1431-errand-coverage');
    expect(res.ok).toBe(true);
    expect(listWorkerFiles(WORKER)).toEqual([]);
  });

  it('deletes a loose file', () => {
    fileWorkerDeliverable({ ...job, artifacts: [{ name: 'report.md', body: 'a' }] });
    expect(deleteWorkerFile(WORKER, '2026-08-16-1431-errand-coverage.md').ok).toBe(true);
    expect(listWorkerFiles(WORKER)).toEqual([]);
  });

  it('refuses to climb out of the worker’s directory', () => {
    const sibling = path.join(userDataDir, 'worker-files', 'worker-2');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.md'), 'x');

    const res = deleteWorkerFile(WORKER, '../worker-2');
    expect(res).toEqual({ ok: false, error: 'That path is outside the worker’s files.' });
    expect(fs.existsSync(path.join(sibling, 'secret.md'))).toBe(true);
  });

  it('refuses to delete the worker’s own root', () => {
    ensureWorkerFilesDir(WORKER);
    expect(deleteWorkerFile(WORKER, '.').ok).toBe(false);
    expect(fs.existsSync(workerFilesDir(WORKER))).toBe(true);
  });

  it('says so when the job is already gone', () => {
    expect(deleteWorkerFile(WORKER, 'never-existed')).toEqual({ ok: false, error: 'Already gone.' });
  });
});

describe('a symlink inside the worker’s own directory', () => {
  // The worker writes here itself — its flow steps are handed this path and a
  // shell — so a link out of it is something it can create, deliberately or by
  // copying one in. Lexical containment (`path.resolve` + startsWith) passes
  // such a path; only a realpath check catches it.
  let outside = '';

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-outside-'));
    fs.writeFileSync(path.join(outside, 'private.md'), 'not the worker’s');
    fs.symlinkSync(outside, path.join(ensureWorkerFilesDir(WORKER), 'escape'));
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses to read through it', () => {
    expect(readWorkerFile(WORKER, 'escape/private.md')).toEqual({
      ok: false,
      error: 'That path is outside the worker’s files.',
    });
  });

  it('refuses to delete through it', () => {
    expect(deleteWorkerFile(WORKER, 'escape/private.md')).toEqual({
      ok: false,
      error: 'That path is outside the worker’s files.',
    });
    expect(fs.existsSync(path.join(outside, 'private.md'))).toBe(true);
  });

  it('still lets the link itself be removed, without touching its target', () => {
    expect(deleteWorkerFile(WORKER, 'escape').ok).toBe(true);
    expect(fs.existsSync(path.join(workerFilesDir(WORKER), 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'private.md'))).toBe(true);
  });
});

describe('filing a file the run wrote itself', () => {
  it('copies it byte for byte instead of reading it as text', () => {
    const src = path.join(userDataDir, 'dashboard.html');
    // A PNG's header, which is exactly what a UTF-8 round trip destroys.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    fs.writeFileSync(src, bytes);
    const res = fileWorkerDeliverable({
      workerId: WORKER,
      task: 'shift',
      label: '[Shift 3] Chief of Staff',
      title: 'Morning briefing',
      at: AT,
      artifacts: [
        { name: 'brief.md', body: '# brief' },
        { name: 'dashboard.html', sourcePath: src },
      ],
    });
    expect(res.written).toBe(true);
    const filed = deliverableFiles({
      workerId: WORKER,
      task: 'shift',
      label: '[Shift 3] Chief of Staff',
      title: 'Morning briefing',
      at: AT,
    });
    const dashboard = filed.find((f) => f.name.endsWith('dashboard.html'));
    expect(dashboard).toBeTruthy();
    expect(fs.readFileSync(dashboard!.path)).toEqual(bytes);
  });

  it('files a lone written file under the job name, keeping its extension', () => {
    const src = path.join(userDataDir, 'dashboard.html');
    fs.writeFileSync(src, '<html>hi</html>');
    fileWorkerDeliverable({
      workerId: WORKER,
      task: 'errand',
      label: '[Errand] dashboard',
      title: 'Build the dashboard',
      at: AT,
      artifacts: [{ name: 'dashboard.html', sourcePath: src }],
    });
    const names = listWorkerFiles(WORKER).map((f) => f.name);
    expect(names).toContain('2026-08-16-1431-errand-build-the-dashboard.html');
  });

  it('does not fail the whole filing when the source is already gone', () => {
    const res = fileWorkerDeliverable({
      workerId: WORKER,
      task: 'shift',
      label: '[Shift 1] Chief of Staff',
      title: 'Morning briefing',
      at: AT,
      artifacts: [
        { name: 'brief.md', body: '# brief' },
        { name: 'dashboard.html', sourcePath: path.join(userDataDir, 'never-existed.html') },
      ],
    });
    expect(res.written).toBe(true);
    const names = listWorkerFiles(WORKER).map((f) => f.name);
    expect(names.some((n) => n.endsWith('brief.md'))).toBe(true);
    expect(names.some((n) => n.endsWith('dashboard.html'))).toBe(false);
  });
});

describe('archiveWorkerFiles', () => {
  const cutoff = AT;
  const oldMtime = new Date(cutoff - 60_000);

  it('moves a filed deliverable older than the cutoff into archive/', () => {
    const dir = ensureWorkerFilesDir(WORKER);
    const file = path.join(dir, '2026-08-01-0900-shift-3-something.md');
    fs.writeFileSync(file, 'x', 'utf-8');
    fs.utimesSync(file, oldMtime, oldMtime);

    expect(archiveWorkerFiles(WORKER, cutoff)).toEqual({ moved: 1 });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'archive', '2026-08-01-0900-shift-3-something.md'))).toBe(
      true,
    );
  });

  it('leaves the worker’s own files at the top level regardless of age', () => {
    const dir = ensureWorkerFilesDir(WORKER);
    const baseline = path.join(dir, 'baseline.json');
    const cursor = path.join(dir, 'cursor.json');
    fs.writeFileSync(baseline, '{}', 'utf-8');
    fs.writeFileSync(cursor, '{}', 'utf-8');
    fs.utimesSync(baseline, oldMtime, oldMtime);
    fs.utimesSync(cursor, oldMtime, oldMtime);

    expect(archiveWorkerFiles(WORKER, cutoff)).toEqual({ moved: 0 });
    expect(fs.existsSync(baseline)).toBe(true);
    expect(fs.existsSync(cursor)).toBe(true);
  });

  it('keeps a deliverable link working after its job folder is archived', () => {
    const job = {
      workerId: WORKER,
      task: 'errand' as const,
      label: '[Errand] x',
      title: 'Coverage',
      at: AT,
    };
    fileWorkerDeliverable({
      ...job,
      artifacts: [
        { name: 'report.md', body: 'a' },
        { name: 'verification.md', body: 'b' },
      ],
    });
    const dir = workerFilesDir(WORKER);
    const folder = path.join(dir, '2026-08-16-1431-errand-coverage');
    const oldFolderMtime = new Date(AT - 60_000);
    fs.utimesSync(folder, oldFolderMtime, oldFolderMtime);

    expect(archiveWorkerFiles(WORKER, AT)).toEqual({ moved: 1 });

    const found = deliverableFiles(job);
    expect(found.map((f) => f.name)).toEqual([
      'archive/2026-08-16-1431-errand-coverage/report.md',
      'archive/2026-08-16-1431-errand-coverage/verification.md',
    ]);
    expect(found.every((f) => fs.existsSync(f.path))).toBe(true);
  });
});

describe('clearWorkerFiles', () => {
  it('empties the cabinet and leaves the neighbours alone', () => {
    const mine = ensureWorkerFilesDir(WORKER);
    fs.writeFileSync(path.join(mine, 'cursor.json'), '{"through":1}', 'utf-8');
    fs.mkdirSync(path.join(mine, '2026-08-16-1431-shift-1'), { recursive: true });
    const theirs = ensureWorkerFilesDir('worker-2');
    fs.writeFileSync(path.join(theirs, 'keep.md'), 'theirs', 'utf-8');

    expect(clearWorkerFiles(WORKER)).toEqual({ ok: true, removed: 1 });
    expect(fs.existsSync(mine)).toBe(false);
    expect(listWorkerFiles('worker-2').map((f) => f.name)).toEqual(['keep.md']);
  });

  it('recreates on demand, so the worker can keep working after a reset', () => {
    const mine = ensureWorkerFilesDir(WORKER);
    fs.writeFileSync(path.join(mine, 'tally.md'), 'x', 'utf-8');
    clearWorkerFiles(WORKER);

    expect(listWorkerFiles(WORKER)).toEqual([]);
    expect(fs.existsSync(ensureWorkerFilesDir(WORKER))).toBe(true);
  });

  it('succeeds for a worker that never wrote anything', () => {
    expect(clearWorkerFiles(WORKER)).toEqual({ ok: true, removed: 0 });
  });
});
