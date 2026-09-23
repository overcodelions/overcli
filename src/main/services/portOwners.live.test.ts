import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchingProcesses, portOwnersFor, processStarted, stopPids } from './portOwners';

// The rest of the suite feeds these functions a canned process table, which is
// how a scan that failed outright on a real machine passed every test: at a
// dozen JVMs `ps -axo args=` is over a megabyte, past what `execFile` would
// buffer by default, and a canned table is never that big. This one builds a
// real leftover — shaped like a Gradle service — and runs the real `ps` and
// `lsof` against it.
//
//   wrapper   `node wrapper.js acme-run serve`, in the checkout, orphaned to
//             launchd. Like gradlew, its argv does not carry the options the
//             app is started with.
//   daemon    in a folder outside the checkout, like `~/.gradle/daemon`.
//   listener  in the checkout's `app` folder, holding the port.

const execFileAsync = promisify(execFile);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(read: () => T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the process tree');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processTableSize(): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.length;
}

const readNumber = (file: string) => {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
};

const LISTENER = `
const fs = require('fs');
const server = require('net').createServer();
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2] + '/listener.pid', String(process.pid));
  fs.writeFileSync(process.argv[2] + '/port', String(server.address().port));
});
`;
const DAEMON = `
const { spawn } = require('child_process');
require('fs').writeFileSync(process.argv[2] + '/daemon.pid', String(process.pid));
spawn(process.execPath, [process.argv[3], process.argv[2]], { cwd: process.argv[4], stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`;
const WRAPPER = `
const { spawn } = require('child_process');
const [state, daemonDir, app] = process.argv.slice(4);
require('fs').writeFileSync(state + '/wrapper.pid', String(process.pid));
spawn(process.execPath, [daemonDir + '/daemon.js', state, daemonDir + '/listener.js', app], { cwd: daemonDir, stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`;

describe.skipIf(process.platform === 'win32')('portOwners against real processes', () => {
  // lsof reports resolved paths, and macOS's tmpdir is a symlink into /private.
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acme-leftover-'));
  const checkout = path.join(base, 'acme-orders');
  const app = path.join(checkout, 'app');
  const daemonDir = path.join(base, 'daemon');
  const elsewhere = path.join(base, 'acme-billing');
  const state = path.join(base, 'state');
  const padding: ChildProcess[] = [];
  let wrapper = 0;
  let daemon = 0;
  let listener = 0;
  let port = 0;
  // Whether the wrapper really went to pid 1. A Linux host with a child
  // subreaper (some CI runners and containers) takes orphans itself, and then
  // nothing here is a leftover by design; those cases skip rather than fail.
  let orphaned = false;

  beforeAll(async () => {
    for (const dir of [app, daemonDir, elsewhere, state]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'wrapper.js'), WRAPPER);
    fs.writeFileSync(path.join(daemonDir, 'daemon.js'), DAEMON);
    fs.writeFileSync(path.join(daemonDir, 'listener.js'), LISTENER);

    // Enough command line to push the process table past a megabyte, added
    // until `ps` itself says so: Linux's procps prints at most ~128 KB of any
    // one command line where macOS prints all of it, so a fixed amount of
    // padding is a megabyte on one and half that on the other. Each pad is a
    // shell whose unused arguments are the bulk — cheap, and gone within a
    // second of being killed.
    const chunk = 'x'.repeat(18_000);
    for (let i = 0; i < 40 && (await processTableSize()) <= 1024 * 1024; i++) {
      for (let j = 0; j < 4; j++) {
        padding.push(spawn('sh', ['-c', 'while :; do sleep 1; done', 'acme-pad', ...Array(5).fill(chunk)], {
          stdio: 'ignore',
        }));
      }
    }

    // Started through a shell that exits at once, so the wrapper is orphaned
    // to launchd exactly as a leftover from a closed app is.
    const node = JSON.stringify(process.execPath);
    await execFileAsync('sh', ['-c', `${node} wrapper.js acme-run serve ${state} ${daemonDir} ${app} >/dev/null 2>&1 &`], {
      cwd: checkout,
    });
    wrapper = await until(() => readNumber(path.join(state, 'wrapper.pid')), 10_000);
    daemon = await until(() => readNumber(path.join(state, 'daemon.pid')), 10_000);
    listener = await until(() => readNumber(path.join(state, 'listener.pid')), 10_000);
    port = await until(() => readNumber(path.join(state, 'port')), 10_000);
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(wrapper)]);
    orphaned = stdout.trim() === '1';
  }, 30_000);

  afterAll(async () => {
    for (const pid of [listener, daemon, wrapper]) {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
    for (const child of padding) child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  });

  // The launch command carries an option only the app ever sees, as a Gradle
  // service's `-D` options do.
  const tokens = ['./acme-run', 'serve', '-Dacme.profile=local'];

  it('is scanning a process table bigger than execFile buffers by default', async () => {
    expect(await processTableSize()).toBeGreaterThan(1024 * 1024);
  });

  it('calls the listener a leftover, rooted at the orphaned wrapper', async (ctx) => {
    if (!orphaned) ctx.skip();
    const owners = (await portOwnersFor([port], () => ({ servicePath: checkout, tokens }))).get(port) ?? [];

    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ pid: listener, kind: 'stale', root: wrapper });
  }, 20_000);

  it('matches the wrapper by its command line, and not for a service elsewhere', async (ctx) => {
    if (!orphaned) ctx.skip();
    const found = await matchingProcesses([
      { key: 'orders', tokens: ['./acme-run', 'serve'], checkout },
      { key: 'billing', tokens: ['./acme-run', 'serve'], checkout: elsewhere },
    ]);

    expect(found.get('orders')).toMatchObject({ pid: wrapper, kind: 'stale', root: wrapper });
    expect(found.has('billing')).toBe(false);
  }, 20_000);

  it('reads a start time for a live pid and none for a gone one', async () => {
    expect(await processStarted(wrapper)).toMatch(/\d{4}/);
    const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => gone.on('exit', resolve));
    expect(await processStarted(gone.pid!)).toBeNull();
  });

  it('takes the whole tree down from its root', async () => {
    await stopPids([wrapper], 1_000, { tree: true });

    expect(await until(() => ([wrapper, daemon, listener].some(alive) ? undefined : true), 5_000)).toBe(true);
  }, 20_000);
});
