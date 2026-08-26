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

import { publishDeliverableToProject, PUBLISH_RETRY_WINDOW_MS } from './workerPublish';
import { workerFilesDir } from './workerFiles';
import { writeEverydayMarker } from '../everydayProject';

const WORKER = 'worker-1';
const HOUR = 60 * 60 * 1000;
let projectDir = '';

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-publish-user-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-publish-project-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function publish(artifacts: Array<{ name: string; body?: string; sourcePath?: string }>, runId = 'run-1') {
  return publishDeliverableToProject({
    workerId: WORKER,
    projectPath: projectDir,
    runId,
    artifacts,
  });
}

describe('publishDeliverableToProject', () => {
  it('refuses a project that is not an everyday folder', () => {
    const res = publish([{ name: 'Summary.md', body: 'hello' }]);
    expect(res).toEqual({ written: [], skipped: 'not-everyday' });
    expect(fs.existsSync(path.join(projectDir, 'Summary.md'))).toBe(false);
  });

  it('files documents into the folder', () => {
    writeEverydayMarker(projectDir);
    const res = publish([{ name: 'Summary.md', body: 'hello' }]);
    expect(res.written).toEqual(['Summary.md']);
    expect(fs.readFileSync(path.join(projectDir, 'Summary.md'), 'utf-8')).toBe('hello');
  });

  it('copies a file the run wrote rather than reading it back as text', () => {
    writeEverydayMarker(projectDir);
    const source = path.join(userDataDir, 'chart.pdf');
    fs.writeFileSync(source, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    publish([{ name: 'chart.pdf', sourcePath: source }]);
    expect(fs.readFileSync(path.join(projectDir, 'chart.pdf'))).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
    );
  });

  it('leaves everything that is not a document in the cabinet', () => {
    writeEverydayMarker(projectDir);
    const res = publish([
      { name: 'build_deck.py', body: 'print(1)' },
      { name: 'Deck.pptx', body: 'x' },
      { name: 'notes', body: 'no extension' },
    ]);
    expect(res.written).toEqual(['Deck.pptx']);
    expect(fs.existsSync(path.join(projectDir, 'build_deck.py'))).toBe(false);
  });

  it('never overwrites what is already in the folder', () => {
    writeEverydayMarker(projectDir);
    publish([{ name: 'Summary.md', body: 'week one' }], 'run-1');
    const res = publish([{ name: 'Summary.md', body: 'week two' }], 'run-2');
    expect(res.written).toEqual(['Summary 2.md']);
    expect(fs.readFileSync(path.join(projectDir, 'Summary.md'), 'utf-8')).toBe('week one');
  });

  it('publishes one run once, however often the fold re-runs', () => {
    writeEverydayMarker(projectDir);
    publish([{ name: 'Summary.md', body: 'hello' }]);
    const again = publish([{ name: 'Summary.md', body: 'hello' }]);
    expect(again).toEqual({ written: [], skipped: 'already-published' });
    expect(fs.readdirSync(projectDir).filter((f) => f.endsWith('.md'))).toEqual(['Summary.md']);
  });

  it('remembers a run that produced no documents', () => {
    writeEverydayMarker(projectDir);
    expect(publish([{ name: 'build.py', body: 'x' }]).skipped).toBe('no-documents');
    expect(publish([{ name: 'build.py', body: 'x' }]).skipped).toBe('already-published');
  });

  it('retries only the artifact that failed, without re-copying what already landed', () => {
    writeEverydayMarker(projectDir);
    const missingSource = path.join(userDataDir, 'missing.pdf');
    // Never created, so `fs.statSync` throws inside the publish loop below —
    // that's the "one bad artifact" case.
    const first = publish([
      { name: 'Summary.md', body: 'hello' },
      { name: 'chart.pdf', sourcePath: missingSource },
    ]);
    expect(first.written).toEqual(['Summary.md']);
    expect(fs.readFileSync(path.join(projectDir, 'Summary.md'), 'utf-8')).toBe('hello');
    expect(fs.existsSync(path.join(projectDir, 'chart.pdf'))).toBe(false);

    // Re-fold with the same run: Summary.md must not be re-copied (no
    // `Summary 2.md`), and chart.pdf must still be attempted since it never
    // succeeded.
    const second = publish([
      { name: 'Summary.md', body: 'hello' },
      { name: 'chart.pdf', sourcePath: missingSource },
    ]);
    expect(second.written).toEqual([]);
    expect(fs.readdirSync(projectDir).filter((f) => f.endsWith('.md'))).toEqual(['Summary.md']);

    // Once the source shows up, the next fold finally delivers it — proof
    // the run was never permanently unledgered by the earlier failure.
    fs.writeFileSync(missingSource, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const third = publish([
      { name: 'Summary.md', body: 'hello' },
      { name: 'chart.pdf', sourcePath: missingSource },
    ]);
    expect(third.written).toEqual(['chart.pdf']);
    expect(fs.existsSync(path.join(projectDir, 'chart.pdf'))).toBe(true);
  });

  it('stops retrying an artifact whose source never arrives, once the window closes', () => {
    writeEverydayMarker(projectDir);
    const missingSource = path.join(userDataDir, 'never.pdf');
    const artifacts = [
      { name: 'Summary.md', body: 'hello' },
      { name: 'never.pdf', sourcePath: missingSource },
    ];
    const at = (now: number) =>
      publishDeliverableToProject({ workerId: WORKER, projectPath: projectDir, runId: 'run-1', artifacts, now });

    expect(at(0).written).toEqual(['Summary.md']);
    // Still inside the window: the source could yet come back, so the run
    // stays open and `never.pdf` is retried rather than written off.
    expect(at(HOUR).skipped).toBeUndefined();

    // Past the window it settles, and says so the way a too-large file does.
    const settled = at(PUBLISH_RETRY_WINDOW_MS + 1);
    expect(settled.skippedNames).toEqual(['never.pdf']);

    // And now the run is finished — no further attempt, no further logging.
    expect(at(PUBLISH_RETRY_WINDOW_MS + HOUR).skipped).toBe('already-published');
  });

  it('treats a pre-0.16.2 ledger entry as fully published, not as a partial doneNames list', () => {
    writeEverydayMarker(projectDir);
    // Pre-0.16.2 shape: a bare array of the filenames that landed. Any entry
    // at all used to mean "this run is done" — seed that directly, bypassing
    // `publish()`, the way an existing install's `.published.json` would.
    const ledgerFile = path.join(workerFilesDir(WORKER), '.published.json');
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ 'run-1': ['Summary.md'] }));

    const res = publish([{ name: 'Summary.md', body: 'hello' }], 'run-1');
    expect(res).toEqual({ written: [], skipped: 'already-published' });
    expect(fs.existsSync(path.join(projectDir, 'Summary.md'))).toBe(false);
    expect(fs.readdirSync(projectDir).filter((f) => f.endsWith('.md'))).toEqual([]);
  });

  it('re-publishes a pre-0.16.2 ledger entry that is a bare EMPTY array', () => {
    writeEverydayMarker(projectDir);
    // An empty legacy array carried no filenames, so it proves nothing was
    // ever filed — honouring it as "complete" would preserve the shift-10
    // defect forever.
    const ledgerFile = path.join(workerFilesDir(WORKER), '.published.json');
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ 'run-1': [] }));

    const res = publish([{ name: 'Summary.md', body: 'hello' }], 'run-1');
    expect(res.written).toEqual(['Summary.md']);
    expect(fs.readFileSync(path.join(projectDir, 'Summary.md'), 'utf-8')).toBe('hello');
  });

  it('refuses a name that would escape the folder', () => {
    writeEverydayMarker(projectDir);
    const res = publish([{ name: '../escaped.md', body: 'nope' }]);
    expect(res.written).toEqual(['escaped.md']);
    expect(fs.existsSync(path.join(path.dirname(projectDir), 'escaped.md'))).toBe(false);
  });
});
