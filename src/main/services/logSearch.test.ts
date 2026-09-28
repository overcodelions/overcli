import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { matchLines, readTail, splitStamp, toMatches } from './logSearch';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('matchLines', () => {
  it('matches case-insensitively and keeps line positions', () => {
    const lines = ['Starting', 'Connection REFUSED on :5432', 'ok', 'connection refused again'];
    expect(matchLines(lines, 'refused')).toEqual([
      { index: 1, text: 'Connection REFUSED on :5432' },
      { index: 3, text: 'connection refused again' },
    ]);
  });

  it('ignores colour codes inside the words it matches', () => {
    expect(matchLines(['\x1b[31mERR\x1b[0mOR boom'], 'error')).toEqual([{ index: 0, text: 'ERROR boom' }]);
  });

  it('keeps the newest matches when there are more than the limit', () => {
    const lines = ['hit 1', 'hit 2', 'hit 3', 'hit 4'];
    expect(matchLines(lines, 'hit', 2).map((m) => m.text)).toEqual(['hit 3', 'hit 4']);
  });

  it('finds nothing for a blank query', () => {
    expect(matchLines(['anything'], '   ')).toEqual([]);
  });
});

describe('file lines', () => {
  it('splits off the stamp and matches only what the service printed', () => {
    expect(splitStamp('2026-09-28T06:40:19.003Z boom')).toEqual({ at: '2026-09-28T06:40:19.003Z', text: 'boom' });
    const lines = ['2026-09-28T06:40:19.003Z boom', '2026-09-28T06:41:00.000Z quiet'];
    expect(toMatches('w', 's', 'file', lines, '06:40')).toEqual([]);
    expect(toMatches('w', 's', 'file', lines, 'boom')).toEqual([
      { workspaceId: 'w', serviceId: 's', source: 'file', index: 0, text: 'boom', at: '2026-09-28T06:40:19.003Z' },
    ]);
  });

  it('reads only the tail of a file and drops the cut first line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-search-'));
    dirs.push(dir);
    const file = path.join(dir, 'a.log');
    fs.writeFileSync(file, 'first line\nsecond line\nthird\n');
    expect(await readTail(file, 1024)).toEqual(['first line', 'second line', 'third']);
    expect(await readTail(file, 14)).toEqual(['third']);
    expect(await readTail(path.join(dir, 'missing.log'))).toEqual([]);
  });
});
