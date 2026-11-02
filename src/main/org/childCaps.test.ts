import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DROP_CAPS, ambientCaps, dropCapsFromChildren, findable, guardChildCaps, isWorkerLaunch, normalize, withoutCaps } from './childCaps';
import { SETPRIV, asWorkerUser } from './workerUser';

const status = (amb: string) => `Name:\tnode\nCapEff:\t00000000000000c2\nCapAmb:\t${amb}\n`;

describe('capabilities for what the server starts', () => {
  it('reads the ambient set', () => {
    expect(ambientCaps(status('00000000000000c2'))).toBe(0xc2n);
    expect(ambientCaps(status('0000000000000000'))).toBe(0n);
    expect(ambientCaps('Name:\tnode\n')).toBe(0n);
  });

  it('starts everything through setpriv with no capabilities, except a worker launch', () => {
    expect(withoutCaps('git', ['status'])).toEqual({ file: SETPRIV, args: [...DROP_CAPS, 'git', 'status'] });
    const worker = asWorkerUser({ uid: 1001, gid: 1001 }, 'claude', ['-p']);
    expect(withoutCaps(worker.command, worker.args)).toEqual({ file: worker.command, args: worker.args });
  });

  it('wraps a setpriv that would switch to root, or keep its capabilities', () => {
    for (const args of [
      ['--reuid=0', '--regid=0', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', 'sh'],
      ['--reuid=1001', '--regid=1001', '--clear-groups', '--', 'sh'],
      ['--reuid=1001', '--regid=1001', '--euid=0', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', 'sh'],
      ['--', 'sh', '--reuid=1001', '--regid=1001', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs'],
    ]) {
      expect(isWorkerLaunch(args)).toBe(false);
      expect(withoutCaps(SETPRIV, args).args.slice(0, DROP_CAPS.length)).toEqual([...DROP_CAPS]);
    }
  });

  it('wraps the shell, not just the first word, of a shell launch', () => {
    expect(normalize('git log | head', undefined, undefined)).toEqual({ file: 'git log | head', args: [], options: {} });
    expect(normalize('git log | head', { shell: true, cwd: '/r' })).toEqual({ file: '/bin/sh', args: ['-c', 'git log | head'], options: { cwd: '/r' } });
    expect(normalize('echo', ['a', 'b'], { shell: '/bin/bash' })).toEqual({ file: '/bin/bash', args: ['-c', 'echo a b'], options: {} });
  });

  it('finds a program the way exec does, so a missing one still fails with ENOENT', () => {
    const exists = (p: string) => ['/usr/bin/git', '/repo/bin/run'].includes(p);
    expect(findable('git', '/usr/local/bin:/usr/bin', '/r', exists)).toBe(true);
    expect(findable('claude', '/usr/local/bin:/usr/bin', '/r', exists)).toBe(false);
    expect(findable('./bin/run', undefined, '/repo', exists)).toBe(true);
    expect(findable('/opt/missing', '/usr/bin', '/r', exists)).toBe(false);
  });

  it('routes async and sync launches through setpriv once installed', () => {
    class ChildProcess extends EventEmitter {
      seen: unknown;
      spawn(options: unknown) { this.seen = options; }
    }
    const calls: unknown[][] = [];
    const cp = {
      ChildProcess,
      spawnSync: (...a: unknown[]) => calls.push(['spawnSync', ...a]),
      execFileSync: (...a: unknown[]) => calls.push(['execFileSync', ...a]),
      execSync: (..._a: unknown[]): unknown => { throw new Error('the original execSync is never called'); },
    };
    dropCapsFromChildren(cp as never);
    const child = new ChildProcess();
    child.spawn({ file: '/bin/sh', args: ['/bin/sh', '-c', 'npm test'], envPairs: [] });
    expect(child.seen).toMatchObject({ file: SETPRIV, args: [SETPRIV, ...DROP_CAPS, '/bin/sh', '-c', 'npm test'] });
    cp.spawnSync('git', ['status'], { cwd: '/r' });
    cp.execFileSync('git', { cwd: '/r' });
    cp.execSync('git log | head', { cwd: '/r' });
    expect(calls).toEqual([
      ['spawnSync', SETPRIV, [...DROP_CAPS, 'git', 'status'], { cwd: '/r' }],
      ['execFileSync', SETPRIV, [...DROP_CAPS, 'git'], { cwd: '/r' }],
      ['execFileSync', SETPRIV, [...DROP_CAPS, '/bin/sh', '-c', 'git log | head'], { cwd: '/r' }],
    ]);
  });

  it('installs only on Linux with ambient capabilities, and refuses to start without setpriv', () => {
    let installs = 0;
    const install = () => { installs++; };
    expect(guardChildCaps({ platform: 'darwin', install })).toEqual({ ok: true, dropping: false });
    expect(guardChildCaps({ platform: 'linux', readStatus: () => status('0000000000000000'), install })).toEqual({ ok: true, dropping: false });
    expect(guardChildCaps({ platform: 'linux', readStatus: () => status('00000000000000c2'), exists: () => true, install })).toEqual({ ok: true, dropping: true });
    expect(installs).toBe(1);
    expect(guardChildCaps({ platform: 'linux', readStatus: () => status('00000000000000c2'), exists: () => false, install })).toMatchObject({ ok: false });
  });
});
