import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTestHost } from '../testHost';
import { removeRunEvidence, runEvidenceDir, runEvidenceFiles } from './runEvidence';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-evidence-'));
  useTestHost(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function put(runId: string, name: string, bytes: number, at: number): void {
  const dir = runEvidenceDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes));
  fs.utimesSync(file, at, at);
}

describe('a run’s evidence', () => {
  it('lives under the tool-home folder, where the ticket tool can attach from', () => {
    expect(runEvidenceDir('run-1')).toBe(path.join(dataDir, 'tool-home', 'run-evidence', 'run-1'));
  });

  it('can’t be pointed outside its folder by the run id', () => {
    expect(runEvidenceDir('../../etc/x')).toBe(path.join(dataDir, 'tool-home', 'run-evidence', 'etcx'));
  });

  it('is nothing for a run that kept none', () => {
    expect(runEvidenceFiles('run-none')).toEqual([]);
  });

  it('lists the files oldest first, leaving out hidden files and folders', () => {
    put('run-1', 'b-second.png', 10, 2000);
    put('run-1', 'a-first.png', 20, 1000);
    put('run-1', '.partial', 5, 500);
    fs.mkdirSync(path.join(runEvidenceDir('run-1'), 'sub'));
    expect(runEvidenceFiles('run-1')).toEqual([
      { name: 'a-first.png', path: path.join(runEvidenceDir('run-1'), 'a-first.png'), bytes: 20 },
      { name: 'b-second.png', path: path.join(runEvidenceDir('run-1'), 'b-second.png'), bytes: 10 },
    ]);
  });

  it('leaves out a file over 16 MB, and lists at most 50', () => {
    put('run-2', 'huge.png', 16 * 1024 * 1024 + 1, 1);
    for (let i = 0; i < 55; i++) put('run-2', `shot-${String(i).padStart(2, '0')}.png`, 1, 1000 + i);
    const files = runEvidenceFiles('run-2');
    expect(files).toHaveLength(50);
    expect(files[0].name).toBe('shot-00.png');
    expect(files.some((f) => f.name === 'huge.png')).toBe(false);
  });

  it('doesn’t follow a link out of the folder', () => {
    const outside = path.join(dataDir, 'secret.txt');
    fs.writeFileSync(outside, 'x');
    fs.mkdirSync(runEvidenceDir('run-3'), { recursive: true });
    fs.symlinkSync(outside, path.join(runEvidenceDir('run-3'), 'link.png'));
    expect(runEvidenceFiles('run-3')).toEqual([]);
  });

  it('goes with the run, and removing it twice is fine', () => {
    put('run-4', 'shot.png', 1, 1);
    removeRunEvidence('run-4');
    expect(fs.existsSync(runEvidenceDir('run-4'))).toBe(false);
    expect(() => removeRunEvidence('run-4')).not.toThrow();
    put('run-5', 'keep.png', 1, 1);
    removeRunEvidence('run-4');
    expect(runEvidenceFiles('run-5')).toHaveLength(1);
  });
});
