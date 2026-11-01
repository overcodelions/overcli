import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeWorkerUser,
  asWorkerUser,
  effectiveCaps,
  enableWorkerUser,
  missingServerCaps,
  readProbe,
  setActiveWorkerUser,
  shareWithWorkers,
  workerLaunch,
  workerUserFrom,
} from './workerUser';

afterEach(() => setActiveWorkerUser(null));

describe('the worker user setting', () => {
  it('is off when unset or blank', () => {
    expect(workerUserFrom({}, 1000)).toBeUndefined();
    expect(workerUserFrom({ OVERCLI_WORKER_UID: '  ' }, 1000)).toBeUndefined();
  });

  it('takes a numeric user, the group defaulting to its id', () => {
    expect(workerUserFrom({ OVERCLI_WORKER_UID: ' 1001 ' }, 1000)).toEqual({ uid: 1001, gid: 1001 });
    expect(workerUserFrom({ OVERCLI_WORKER_UID: '1001', OVERCLI_WORKER_GID: '2002' }, 1000)).toEqual({ uid: 1001, gid: 2002 });
  });

  it('refuses root, names and the server\'s own user, saying why', () => {
    expect(workerUserFrom({ OVERCLI_WORKER_UID: '0' }, 1000)).toEqual({ error: expect.stringContaining('root') });
    expect(workerUserFrom({ OVERCLI_WORKER_UID: 'worker' }, 1000)).toEqual({ error: expect.stringContaining('not a number') });
    expect(workerUserFrom({ OVERCLI_WORKER_UID: '1001', OVERCLI_WORKER_GID: 'staff' }, 1000)).toEqual({ error: expect.stringContaining('OVERCLI_WORKER_GID') });
    expect(workerUserFrom({ OVERCLI_WORKER_UID: '1000' }, 1000)).toEqual({ error: expect.stringContaining('own user') });
  });
});

describe('launching as the worker user', () => {
  const user = { uid: 1001, gid: 1001 };

  it('wraps the command in setpriv with no capabilities and no new privileges, keeping its arguments intact', () => {
    const { command, args } = asWorkerUser(user, '/usr/local/bin/claude', ['-p', '--model', 'it\'s "quoted"; rm -rf /']);
    expect(command).toBe('/usr/bin/setpriv');
    expect(args.slice(0, 7)).toEqual(['--reuid=1001', '--regid=1001', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--']);
    // The command and its args ride as positional parameters, never inside the script.
    expect(args.slice(7)).toEqual(['/bin/sh', '-c', 'umask 007; exec "$@"', 'overcli-worker', '/usr/local/bin/claude', '-p', '--model', 'it\'s "quoted"; rm -rf /']);
  });

  it('leaves launches alone when workers run as the server', () => {
    expect(workerLaunch('claude', ['-p'])).toEqual({ command: 'claude', args: ['-p'] });
    setActiveWorkerUser(user);
    expect(workerLaunch('claude', ['-p']).command).toBe('/usr/bin/setpriv');
  });

  it('shares a file with the worker group only when a worker user is active', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-share-'));
    const file = path.join(dir, 'f.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    shareWithWorkers(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Our own primary group stands in for the worker group: chgrp to it needs no privilege.
    const gid = process.getgid?.() ?? 0;
    setActiveWorkerUser({ uid: 1001, gid });
    shareWithWorkers(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o660);
    expect(fs.statSync(file).gid).toBe(gid);
    fs.mkdirSync(path.join(dir, 'att'), { mode: 0o700 });
    shareWithWorkers(path.join(dir, 'att'));
    expect(fs.statSync(path.join(dir, 'att')).mode & 0o777).toBe(0o770);
  });
});

describe('the startup check', () => {
  // The server's uid is fixed, so a host whose own user is 1001 (CI runners are) can't change the outcome.
  const linux = { platform: 'linux' as const, exists: () => true, dataDir: '/data', home: '/data/home', serverUid: 1000 };
  const capsLine = (hex: string) => `Name:\tnode\nCapEff:\t${hex}\n`;

  it('reads capabilities and names what is missing', () => {
    expect(effectiveCaps(capsLine('00000000000000c2'))).toBe(0xc2n);
    expect(missingServerCaps(0xc2n)).toBeUndefined();
    expect(missingServerCaps(0xc0n)).toBe('dac_override');
    expect(missingServerCaps(0n)).toBe('setuid, setgid, dac_override');
  });

  it('fails only when every line is ok', () => {
    expect(readProbe('ok a\nok b\n')).toEqual({ ok: true, lines: ['ok a', 'ok b'] });
    expect(readProbe('ok a\nFAIL can read /data/secrets.key\n').ok).toBe(false);
    expect(readProbe('').ok).toBe(false);
  });

  it('does nothing when the setting is off', async () => {
    expect(await enableWorkerUser({ ...linux, env: {} })).toEqual({ ok: true, lines: [] });
    expect(activeWorkerUser()).toBeNull();
  });

  it('refuses to start, saying why, when the server cannot switch user', async () => {
    const res = await enableWorkerUser({ ...linux, env: { OVERCLI_WORKER_UID: '1001' }, readStatus: () => capsLine('0000000000000000') });
    expect(res.ok).toBe(false);
    expect(res.lines[0]).toContain('user: "0"');
    expect(activeWorkerUser()).toBeNull();
    expect((await enableWorkerUser({ ...linux, platform: 'darwin', env: { OVERCLI_WORKER_UID: '1001' } })).ok).toBe(false);
  });

  it('runs the probe as the worker with none of the server\'s environment, and turns on only when it passes', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const passing = (file: string, args: string[], o: { env: NodeJS.ProcessEnv }, cb: (e: Error | null, out: string) => void) => {
      calls.push({ file, args, env: o.env });
      cb(null, 'ok has no capabilities\nok cannot read /data/secrets.key\n');
    };
    const res = await enableWorkerUser({ ...linux, env: { OVERCLI_WORKER_UID: '1001' }, readStatus: () => capsLine('00000000000000c2'), exec: passing, cli: 'claude' });
    expect(res.ok).toBe(true);
    expect(activeWorkerUser()).toEqual({ uid: 1001, gid: 1001 });
    expect(calls[0].file).toBe('/usr/bin/setpriv');
    expect(calls[0].args).toContain('--reuid=1001');
    expect(Object.keys(calls[0].env).sort()).toEqual(['HOME', 'PATH', 'PROBE_CLI', 'PROBE_PID', 'PROBE_SECRETS', 'PROBE_WRITABLE']);
    expect(calls[0].env.PROBE_SECRETS).toContain('/data/org/tool-gateway.key');
    // Every folder a worker's CLI writes to is checked, workspaces and its own folder included.
    expect(calls[0].env.PROBE_WRITABLE?.split('\n')).toEqual(expect.arrayContaining(['/data/home', '/data/repos', '/data/workspaces', '/data/worker-files', '/data/team-files']));

    setActiveWorkerUser(null);
    const failing = (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'ok has no capabilities\nFAIL can read /data/org/tool-gateway.key\n');
    const bad = await enableWorkerUser({ ...linux, env: { OVERCLI_WORKER_UID: '1001' }, readStatus: () => capsLine('00000000000000c2'), exec: failing });
    expect(bad.ok).toBe(false);
    expect(bad.lines.join('\n')).toContain('FAIL can read /data/org/tool-gateway.key');
    expect(activeWorkerUser()).toBeNull();
  });
});
