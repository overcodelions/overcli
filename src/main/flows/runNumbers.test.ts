import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextRunNumber } from './runNumbers';

describe('nextRunNumber', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnums-'));
    file = path.join(dir, 'run-numbers.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts from 1 for each worker on its own', () => {
    expect(nextRunNumber(file, 'a', [])).toBe(1);
    expect(nextRunNumber(file, 'a', [])).toBe(2);
    expect(nextRunNumber(file, 'b', [])).toBe(1);
  });

  it('never reuses a number after old runs are pruned', () => {
    for (let i = 0; i < 5; i++) nextRunNumber(file, 'a', []);
    expect(nextRunNumber(file, 'a', [{ workerId: 'a', number: 5 }])).toBe(6);
  });

  it('stays above the runs on disk when the file is lost', () => {
    expect(nextRunNumber(file, 'a', [{ workerId: 'a', number: 41 }, { workerId: 'b', number: 90 }, { workerId: 'a' }])).toBe(42);
  });

  it('starts over from a corrupt file without throwing', () => {
    fs.writeFileSync(file, '{not json');
    expect(nextRunNumber(file, 'a', [])).toBe(1);
  });
});
