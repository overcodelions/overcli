import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeEverydayMarker } from '../everydayProject';
import { isEverydayWorkerRun } from './runtime';

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isEverydayWorkerRun', () => {
  it('is true only for a worker run whose source folder is an everyday project', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-everyday-run-'));
    expect(isEverydayWorkerRun({ workerId: 'w', sourceProjectPath: dir })).toBe(false);
    writeEverydayMarker(dir);
    expect(isEverydayWorkerRun({ workerId: 'w', sourceProjectPath: dir })).toBe(true);
    expect(isEverydayWorkerRun({ workerId: undefined, sourceProjectPath: dir })).toBe(false);
    expect(isEverydayWorkerRun({ workerId: 'w', sourceProjectPath: undefined })).toBe(false);
  });
});
