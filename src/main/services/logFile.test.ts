import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogSink, stripAnsi } from './logFile';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLogSink', () => {
  it('appends timestamped lines with colour codes stripped, creating the folder', async () => {
    const dir = tmp();
    const sink = createLogSink((id) => path.join(dir, 'logs', `${id}.log`));
    sink.write('api', '\x1b[36m[vite]\x1b[39m ready');
    sink.write('api', 'second');
    await sink.close('api');

    const lines = fs.readFileSync(path.join(dir, 'logs', 'api.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[vite\] ready$/);
    expect(lines[1]).toMatch(/ second$/);
  });

  it('keeps what an earlier run wrote', async () => {
    const dir = tmp();
    const file = (id: string) => path.join(dir, `${id}.log`);
    const first = createLogSink(file);
    first.write('api', 'before');
    await first.close('api');
    const second = createLogSink(file);
    second.write('api', 'after');
    await second.close('api');

    expect(fs.readFileSync(file('api'), 'utf8')).toMatch(/before\n.*after\n$/);
  });

  it('rotates to .1.log past the limit', async () => {
    const dir = tmp();
    const sink = createLogSink((id) => path.join(dir, `${id}.log`), 100);
    sink.write('api', 'x'.repeat(120));
    await sink.close('api');
    sink.write('api', 'fresh');
    await sink.close('api');

    expect(fs.readFileSync(path.join(dir, 'api.1.log'), 'utf8')).toContain('x'.repeat(120));
    expect(fs.readFileSync(path.join(dir, 'api.log'), 'utf8')).toMatch(/ fresh\n$/);
  });

  it('does not throw when the file cannot be written', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'blocker'), '');
    const sink = createLogSink(() => path.join(dir, 'blocker', 'api.log'));
    expect(() => sink.write('api', 'line')).not.toThrow();
  });
});

describe('stripAnsi', () => {
  it('removes SGR and OSC sequences', () => {
    expect(stripAnsi('\x1b[1;31mERR\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('ERR link');
  });
});
