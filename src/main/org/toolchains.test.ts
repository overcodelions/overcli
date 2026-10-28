import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCustom, correttoUrl, MAX_DOWNLOAD_BYTES, ToolchainService, versionsAskedIn, type ToolchainState } from './toolchains';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BYTES = 'archive bytes';
const SUM = createHash('sha256').update(BYTES).digest('hex');

function harness(opts: { mac?: boolean; badSum?: boolean; noSum?: boolean; status?: number; size?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchains-'));
  dirs.push(root);
  const clone = path.join(root, 'repos', 'billing');
  fs.mkdirSync(path.join(clone, '.git', 'worktrees', 'ACME-1'), { recursive: true });
  const worktree = path.join(root, 'worktrees', 'billing', 'ACME-1');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(clone, '.git', 'worktrees', 'ACME-1')}\n`);
  let state: ToolchainState = { toolchains: [], defaults: {}, repoPicks: {} };
  const fetched: string[] = [];
  const svc = new ToolchainService({
    dir: path.join(root, 'toolchains'),
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    repos: () => [{ name: 'billing', path: clone }, { name: 'web', path: path.join(root, 'repos', 'web') }],
    fetchImpl: (async (url: string) => {
      fetched.push(url);
      const sum = opts.badSum ? '0'.repeat(64) : SUM;
      if (url.includes('latest_sha256')) return opts.noSum ? new Response('', { status: 503 }) : new Response(`${sum}  file\n`);
      if (url.endsWith('index.json')) return new Response(JSON.stringify([{ version: 'v22.11.0' }, { version: 'v20.18.1' }, { version: 'v20.18.0' }]));
      if (url.endsWith('SHASUMS256.txt')) return new Response(`${sum}  node-v20.18.1-linux-arm64.tar.gz\nffff  node-v20.18.1-linux-x64.tar.gz\n`);
      if (url.includes('mode=json')) return new Response(JSON.stringify([{ version: 'go1.23.4', stable: true, files: [{ filename: 'go1.23.4.linux-arm64.tar.gz', os: 'linux', arch: 'arm64', kind: 'archive', sha256: sum }] }]));
      return new Response(BYTES, { status: opts.status ?? 200, ...(opts.size ? { headers: { 'content-length': String(opts.size) } } : {}) });
    }) as unknown as typeof fetch,
    // What the real archives hold: one top folder, a Mac JDK's Contents/Home.
    extract: async (_archive, dest) => {
      const top = path.join(dest, 'pkg-1.0');
      fs.mkdirSync(path.join(opts.mac ? path.join(top, 'Contents', 'Home') : top, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(top, 'tools', 'bin'), { recursive: true });
    },
    uvInstall: async (version, dir) => {
      fs.mkdirSync(path.join(dir, `cpython-${version}.7-linux-aarch64-gnu`, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.lock'), '');
    },
    probe: async (bin) => `${path.basename(bin)} says hello\n`,
    platform: opts.mac ? 'darwin' : 'linux',
    arch: 'arm64',
    now: () => 1,
  });
  const install = async (kit: string, version: string, custom?: Parameters<ToolchainService['install']>[3]) => {
    const s = svc.install(kit, version, 'Pat', custom);
    if (!s.ok) throw new Error(s.error);
    await s.done;
    return state.toolchains.find((t) => t.id === s.toolchain.id)!;
  };
  return { svc, root, clone, worktree, fetched, install, state: () => state };
}

describe('toolchains', () => {
  it('links the Corretto build and its checksum for the machine, or says there is none', () => {
    expect(correttoUrl('8', { platform: 'linux', arch: 'x64' })).toEqual({
      ok: true,
      url: 'https://corretto.aws/downloads/latest/amazon-corretto-8-x64-linux-jdk.tar.gz',
      sumUrl: 'https://corretto.aws/downloads/latest_sha256/amazon-corretto-8-x64-linux-jdk.tar.gz',
    });
    expect(correttoUrl('17', { platform: 'win32', arch: 'x64' }).ok).toBe(false);
  });

  it('installs Java from its one top folder, checks the sum, and sets PATH and JAVA_HOME', async () => {
    const h = harness();
    const t = await h.install('java', '8');
    expect(t).toMatchObject({ status: 'ready', detail: 'java says hello', home: path.join(h.root, 'toolchains', 'java-8', 'pkg-1.0') });
    expect(h.svc.env({ PATH: '/usr/bin' })).toMatchObject({ JAVA_HOME: t.home, PATH: `${path.join(t.home!, 'bin')}:/usr/bin` });
    expect(fs.readdirSync(path.join(h.root, 'toolchains'))).toEqual(['java-8']);
  });

  it('uses Contents/Home for a Mac JDK', async () => {
    const h = harness({ mac: true });
    expect((await h.install('java', '17')).home).toBe(path.join(h.root, 'toolchains', 'java-17', 'pkg-1.0', 'Contents', 'Home'));
  });

  it('picks the latest Node of a major and Go of a minor, with their published sums', async () => {
    const h = harness();
    expect(await h.install('node', '20')).toMatchObject({ status: 'ready', detail: 'node says hello' });
    expect(h.fetched).toContain('https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-arm64.tar.gz');
    const go = await h.install('go', '1.23');
    expect(go.status).toBe('ready');
    expect(h.fetched).toContain('https://go.dev/dl/go1.23.4.linux-arm64.tar.gz');
    expect(h.svc.env({}).GOROOT).toBe(go.home);
  });

  it('installs Python through uv into its own folder', async () => {
    const h = harness();
    const t = await h.install('python', '3.12');
    expect(t).toMatchObject({ status: 'ready', detail: 'python3 says hello', home: path.join(h.root, 'toolchains', 'python-3.12', 'cpython-3.12.7-linux-aarch64-gnu') });
  });

  it('refuses a download that does not match its sum, or fails, and leaves nothing behind', async () => {
    for (const opts of [{ badSum: true }, { status: 404 }]) {
      const h = harness(opts);
      const t = await h.install('java', '11');
      expect(t).toMatchObject({ status: 'failed', error: expect.stringMatching(opts.badSum ? /sha256/ : /HTTP 404/) });
      expect(h.svc.env({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
      expect(fs.readdirSync(path.join(h.root, 'toolchains'))).toEqual([]);
    }
  });

  it('keeps the working install when a reinstall fails', async () => {
    for (const fail of [{ status: 503 }, { badSum: true }]) {
      const opts: Parameters<typeof harness>[0] = {};
      const h = harness(opts);
      const first = await h.install('java', '17');
      expect(first.status).toBe('ready');
      Object.assign(opts, fail);
      const again = await h.install('java', '17');
      expect(again).toMatchObject({ status: 'ready', home: first.home, error: expect.stringContaining('the installed one stays') });
      expect(fs.existsSync(path.join(first.home!, 'bin'))).toBe(true);
      expect(h.svc.env({ PATH: '/usr/bin' }).PATH).toBe(`${path.join(first.home!, 'bin')}:/usr/bin`);
      expect(fs.readdirSync(path.join(h.root, 'toolchains'))).toEqual(['java-17']);
    }
  });

  it('installs nothing from the catalog without its published checksum', async () => {
    const java = await harness({ noSum: true }).install('java', '17');
    expect(java).toMatchObject({ status: 'failed', error: expect.stringContaining('checksum') });
    // nodejs.org lists no darwin-arm64 line in this SHASUMS256.txt.
    const node = await harness({ mac: true }).install('node', '20');
    expect(node).toMatchObject({ status: 'failed', error: expect.stringContaining('no checksum') });
  });

  it('refuses a download over the size cap', async () => {
    const t = await harness({ size: MAX_DOWNLOAD_BYTES + 1 }).install('java', '17');
    expect(t).toMatchObject({ status: 'failed', error: expect.stringContaining('MB, so nothing was installed') });
  });

  it('installs a custom kit with its bin folder and variables, on every run', async () => {
    const h = harness();
    const t = await h.install('custom', 'Acme-CLI', { url: 'https://acme.example/acme-cli.tar.gz', sha256: SUM, bin: 'tools/bin', env: { ACME_HOME: '{home}' } });
    expect(t).toMatchObject({ id: 'custom-acme-cli', status: 'ready', detail: 'Installed' });
    const env = h.svc.env({ PATH: '/usr/bin' }, h.root);
    expect(env.ACME_HOME).toBe(t.home);
    expect(env.PATH).toBe(`${path.join(t.home!, 'tools', 'bin')}:/usr/bin`);
  });

  it('checks a custom kit before fetching anything', () => {
    expect(checkCustom({ name: 'x', url: 'http://acme.example/x.tgz' })).toMatchObject({ ok: false, error: expect.stringContaining('https') });
    expect(checkCustom({ name: 'x', url: 'https://acme.example/x.tgz', sha256: 'abc' }).ok).toBe(false);
    expect(checkCustom({ name: 'x', url: 'https://acme.example/x.tgz', bin: '../../etc' }).ok).toBe(false);
    expect(checkCustom({ name: 'x', url: 'https://acme.example/x.tgz', env: { LD_PRELOAD: '{home}/x.so' } })).toMatchObject({ ok: false, error: expect.stringContaining('LD_PRELOAD') });
    expect(checkCustom({ name: 'Bad Name', url: 'https://acme.example/x.tgz' }).ok).toBe(false);
  });

  it('reads what a repo asks for in its own files', () => {
    const h = harness();
    fs.writeFileSync(path.join(h.worktree, '.nvmrc'), 'v20.11.0\n');
    fs.writeFileSync(path.join(h.worktree, '.sdkmanrc'), '# sdk\njava=8.0.422-amzn\n');
    fs.writeFileSync(path.join(h.worktree, '.python-version'), '3.12.4\n');
    fs.writeFileSync(path.join(h.worktree, 'go.mod'), 'module acme\n\ngo 1.23.0\n');
    expect(versionsAskedIn(h.worktree)).toEqual({ node: '20', java: '8', python: '3.12', go: '1.23' });
    fs.writeFileSync(path.join(h.clone, '.tool-versions'), 'nodejs 22.1.0\njava temurin-17.0.2\n');
    expect(versionsAskedIn(h.clone)).toEqual({ node: '22', java: '17' });
    expect(versionsAskedIn(path.join(h.root, 'nowhere'))).toEqual({});
  });

  it("gives a run the repo's pick, else what the repo asks for if installed, else the default", async () => {
    const h = harness();
    const j17 = await h.install('java', '17');
    const j8 = await h.install('java', '8');
    const inRepo = path.join(h.worktree, 'src');
    expect(h.svc.repoAt(inRepo)).toEqual({ name: 'billing', root: h.worktree });
    // Nothing set: the first installed.
    expect(h.svc.env({}, inRepo).JAVA_HOME).toBe(j17.home);
    // The repo asks for 8 in its own files.
    fs.writeFileSync(path.join(h.worktree, '.sdkmanrc'), 'java=8.0.422-amzn\n');
    expect(h.svc.env({}, inRepo).JAVA_HOME).toBe(j8.home);
    // An admin's pick wins over the file.
    expect(h.svc.setRepoPick('billing', 'java', '17')).toEqual({ ok: true });
    expect(h.svc.env({}, inRepo).JAVA_HOME).toBe(j17.home);
    // Elsewhere: the default.
    expect(h.svc.setDefault('java', '8')).toEqual({ ok: true });
    expect(h.svc.env({}, h.root).JAVA_HOME).toBe(j8.home);
  });

  it("won't remove a version a repo uses, or pick one that isn't installed", async () => {
    const h = harness();
    await h.install('java', '8');
    expect(h.svc.setRepoPick('billing', 'java', '21')).toEqual({ ok: false, error: 'Install Java 21 first.' });
    expect(h.svc.setRepoPick('nope', 'java', '8').ok).toBe(false);
    h.svc.setRepoPick('billing', 'java', '8');
    expect(h.svc.remove('java-8')).toMatchObject({ ok: false, error: expect.stringContaining('billing is set to java-8') });
    h.svc.setRepoPick('billing', 'java', null);
    expect(h.svc.remove('java-8')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(h.root, 'toolchains', 'java-8'))).toBe(false);
    expect(h.svc.install('java', '9', 'Pat').ok).toBe(false);
    expect(h.svc.install('ruby', '3', 'Pat').ok).toBe(false);
  });

  it('marks a download a restart cut short as failed', async () => {
    const h = harness();
    const s = h.svc.install('java', '8', 'Pat');
    h.svc.recover();
    expect(h.state().toolchains[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('restarted') });
    if (s.ok) await s.done;
  });
});
