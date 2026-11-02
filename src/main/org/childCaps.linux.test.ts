// The child_process patch against the real module, where it can run: Linux
// with setpriv. setpriv sets no_new_privs on everything it starts, so a
// child that went through it shows NoNewPrivs: 1 in its own status, which
// only the child can read (so it greps it, rather than the test reading a file).
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropCapsFromChildren } from './childCaps';
import { SETPRIV } from './workerUser';

const live = process.platform === 'linux' && fs.existsSync(SETPRIV);
const nnp = (status: string) => /^NoNewPrivs:\s*(\d)/m.exec(status)?.[1];

describe.skipIf(!live)('the capability drop on the real child_process', () => {
  it('starts spawn, execFile, execFileSync, spawnSync and execSync children through setpriv', async () => {
    expect(nnp(childProcess.execFileSync('grep', ['^NoNewPrivs', '/proc/self/status']).toString())).toBe('0');
    dropCapsFromChildren();
    expect(nnp(childProcess.execFileSync('grep', ['^NoNewPrivs', '/proc/self/status']).toString())).toBe('1');
    expect(nnp(childProcess.spawnSync('grep', ['^NoNewPrivs', '/proc/self/status']).stdout.toString())).toBe('1');
    expect(childProcess.execSync('grep NoNewPrivs /proc/self/status | tr -d "[:space:]"').toString()).toBe('NoNewPrivs:1');
    const viaSpawn = await new Promise<string>((resolve) => {
      let out = '';
      const c = childProcess.spawn('sh', ['-c', 'grep ^NoNewPrivs /proc/self/status']);
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out));
    });
    expect(nnp(viaSpawn)).toBe('1');
    const viaExecFile = await new Promise<string>((resolve) => childProcess.execFile('grep', ['^NoNewPrivs', '/proc/self/status'], (_e, stdout) => resolve(String(stdout))));
    expect(nnp(viaExecFile)).toBe('1');
    // A missing program still fails the way it always did.
    expect(() => childProcess.execFileSync('no-such-program-acme')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
