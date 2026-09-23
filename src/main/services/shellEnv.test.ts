import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseShellEnv, readShellEnv, shellFlags } from './shellEnv';

describe('parseShellEnv', () => {
  const mark = '__m__';

  it('reads the environment between the markers, whatever the rc files printed around it', () => {
    const out = `Welcome back!\n${mark}${JSON.stringify({ JAVA_HOME: '/jdk', PATH: '/sdk/bin:/usr/bin' })}${mark}\nbye`;
    expect(parseShellEnv(out, mark)).toEqual({ JAVA_HOME: '/jdk', PATH: '/sdk/bin:/usr/bin' });
  });

  it('drops what only the probe and the shell run put there', () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', PWD: '/Users/x', SHLVL: '2', _: '/bin/node', AWS_PROFILE: 'dev' };
    expect(parseShellEnv(`${mark}${JSON.stringify(env)}${mark}`, mark)).toEqual({ AWS_PROFILE: 'dev' });
  });

  it('keeps a value with a newline in it intact', () => {
    const env = { KEY: 'line one\nline two' };
    expect(parseShellEnv(`${mark}${JSON.stringify(env)}${mark}`, mark)).toEqual(env);
  });

  it('gives up on output that is not an environment', () => {
    expect(parseShellEnv('no markers here', mark)).toBeUndefined();
    expect(parseShellEnv(`${mark}not json${mark}`, mark)).toBeUndefined();
    expect(parseShellEnv(`${mark}[1,2]${mark}`, mark)).toBeUndefined();
  });
});

describe('shellFlags', () => {
  it('runs rc files and the profile, except where csh cannot take both', () => {
    expect(shellFlags('/bin/zsh')).toEqual(['-i', '-l', '-c']);
    expect(shellFlags('/opt/homebrew/bin/fish')).toEqual(['-i', '-l', '-c']);
    expect(shellFlags('/bin/tcsh')).toEqual(['-ic']);
  });
});

describe.skipIf(process.platform === 'win32')('readShellEnv', () => {
  it('returns what the shell exported, read back through node', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-shellenv-'));
    // A stand-in shell: exports what an rc file would, then runs the probe.
    const shell = path.join(dir, 'fakesh');
    fs.writeFileSync(shell, '#!/bin/sh\nexport JAVA_HOME=/fake/jdk\necho "rc noise"\nshift $(($# - 1))\nexec /bin/sh -c "$1"\n', { mode: 0o755 });
    try {
      const env = await readShellEnv({ shell, execPath: process.execPath });
      expect(env?.JAVA_HOME).toBe('/fake/jdk');
      expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up on a shell that never finishes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-shellenv-'));
    const shell = path.join(dir, 'hangsh');
    fs.writeFileSync(shell, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    try {
      await expect(readShellEnv({ shell, timeoutMs: 200 })).rejects.toThrow(/took longer/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
