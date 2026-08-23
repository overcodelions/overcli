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

import { publishDeliverableToProject } from './workerPublish';
import { writeEverydayMarker } from '../everydayProject';

const WORKER = 'worker-1';
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

  it('refuses a name that would escape the folder', () => {
    writeEverydayMarker(projectDir);
    const res = publish([{ name: '../escaped.md', body: 'nope' }]);
    expect(res.written).toEqual(['escaped.md']);
    expect(fs.existsSync(path.join(path.dirname(projectDir), 'escaped.md'))).toBe(false);
  });
});
