import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolchainService, kitsNeededIn, rangeAllows, rangesAskedIn, toolchainNote, versionsAskedIn, type Toolchain, type ToolchainState } from './toolchains';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-kits-'));
  dirs.push(root);
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, f), body);
  return root;
}

const installed = (kit: Toolchain['kit'], version: string): Toolchain => ({ id: `${kit}-${version}`, kit, version, status: 'ready', home: `/tc/${kit}-${version}`, by: 'Bo', at: 0 });

function service(repos: Array<{ name: string; path: string }>, state: Partial<ToolchainState>) {
  let s: ToolchainState = { toolchains: [], defaults: {}, repoPicks: {}, ...state };
  return new ToolchainService({ dir: '/tc', store: { load: () => s, save: (v) => (s = v) }, repos: () => repos });
}

describe('what a repo asks for', () => {
  it('reads build files and manifests when no version file says', () => {
    expect(versionsAskedIn(repoWith({ 'build.gradle.kts': 'java { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }' }))).toEqual({ java: '17' });
    expect(versionsAskedIn(repoWith({ 'build.gradle': 'sourceCompatibility = JavaVersion.VERSION_1_8' }))).toEqual({ java: '8' });
    expect(versionsAskedIn(repoWith({ 'pom.xml': '<properties><maven.compiler.release>21</maven.compiler.release></properties>' }))).toEqual({ java: '21' });
    expect(versionsAskedIn(repoWith({ 'package.json': '{"engines":{"node":">=20.11"}}' }))).toEqual({ node: '20' });
    expect(versionsAskedIn(repoWith({ 'pyproject.toml': 'requires-python = ">=3.11"' }))).toEqual({ python: '3.11' });
    expect(versionsAskedIn(repoWith({ '.nvmrc': 'lts/iron' }))).toEqual({ node: '20' });
    expect(versionsAskedIn(repoWith({ '.nvmrc': 'lts/*' }))).toEqual({});
  });

  it('lets a version file win over a manifest', () => {
    expect(versionsAskedIn(repoWith({ '.nvmrc': '22', 'package.json': '{"engines":{"node":">=18"}}' }))).toEqual({ node: '22' });
  });

  it('needs Gradle only without the wrapper, and Java either way', () => {
    expect([...kitsNeededIn(repoWith({ 'build.gradle': '', gradlew: '' }))].sort()).toEqual(['java']);
    expect([...kitsNeededIn(repoWith({ 'settings.gradle.kts': '' }))].sort()).toEqual(['gradle', 'java']);
    expect([...kitsNeededIn(repoWith({ 'package.json': '{}', 'go.mod': 'go 1.23' }))].sort()).toEqual(['go', 'node']);
  });
});

describe('what a run in a repo gets', () => {
  it('flags a kit a repo needs with none installed, and offers the version it asks for', () => {
    const api = repoWith({ 'build.gradle': 'JavaLanguageVersion.of(17)', gradlew: '' });
    const tc = service([{ name: 'api', path: api }], {});
    expect(tc.usesAt(api)).toEqual([{ kit: 'java', label: 'Java', asked: '17', gap: 'Java 17 is needed and no Java is installed', install: '17' }]);
    expect(tc.gapsByRepo()).toEqual({ api: [expect.objectContaining({ kit: 'java', install: '17' })] });
  });

  it('flags a version it asks for that falls back to the default, but not an admin’s pick', () => {
    const app = repoWith({ '.nvmrc': '18' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '20')] });
    expect(tc.usesAt(app)).toEqual([expect.objectContaining({ got: '20', from: 'default', install: '18', gap: 'the repo asks for Node.js 18, which isn’t installed, so runs get Node.js 20' })]);
    const picked = service([{ name: 'app', path: app }], { toolchains: [installed('node', '20')], repoPicks: { app: { node: '20' } } });
    expect(picked.usesAt(app)).toEqual([{ kit: 'node', label: 'Node.js', asked: '18', got: '20', from: 'pick' }]);
  });

  it('says a version the catalog doesn’t carry can’t be installed from here', () => {
    const app = repoWith({ '.nvmrc': '16' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '20')] });
    const [use] = tc.usesAt(app);
    expect(use.gap).toContain('which the catalog doesn’t offer');
    expect(use.install).toBeUndefined();
  });

  it('is nothing outside a connected repo', () => {
    expect(service([], {}).usesAt(repoWith({ '.nvmrc': '20' }))).toEqual([]);
  });

  it('tells the worker what it has, what’s missing, and not to reach for nvm', () => {
    const lines = toolchainNote([
      { kit: 'node', label: 'Node.js', asked: '20', got: '20', from: 'repo' },
      { kit: 'java', label: 'Java', asked: '17', gap: 'Java 17 is needed and no Java is installed', install: '17' },
    ], ' in api');
    expect(lines[0]).toBe('Build tools on PATH in api: Node.js 20 (as the repo asks). There is no nvm, sdkman or pyenv here, and none is needed; do not try to install toolchains.');
    expect(lines[1]).toContain('Missing in api: Java 17 is needed and no Java is installed.');
  });
});

describe('a version given as a range', () => {
  it('reads npm and Python ranges against an installed line', () => {
    const cases: Array<[string, string, boolean]> = [
      ['>=18', '22', true],
      ['>=18', '16', false],
      ['>=20.11', '20', true],
      ['>18', '18', false],
      ['>18', '20', true],
      ['>18.2', '18', true],
      ['<20', '20', false],
      ['<=20', '20', true],
      ['^20.11', '20', true],
      ['^20.11', '22', false],
      ['^0.4', '0', true],
      ['~18.17', '18', true],
      ['~18.17', '20', false],
      ['20.x', '20', true],
      ['20.x', '22', false],
      ['*', '26', true],
      ['22', '22', true],
      ['22', '20', false],
      ['18.x || 20.x || >=22', '24', true],
      ['18.x || 20.x', '22', false],
      ['>= 18 < 23', '22', true],
      ['>=18 <23', '24', false],
      ['16 - 20', '20', true],
      ['16 - 20', '22', false],
      ['>=3.9,<4', '3.12', true],
      ['>=3.9, <3.12', '3.12', false],
      ['~=3.11', '3.13', true],
      ['~=3.11.2', '3.12', false],
      ['==3.12.*', '3.12', true],
      ['!=3.10, >=3.9', '3.11', true],
      ['>=1.0.0-rc.1', '1', true],
    ];
    for (const [range, version, allowed] of cases) expect([range, version, rangeAllows(range, version)]).toEqual([range, version, allowed]);
    expect(rangeAllows('latest', '22')).toBeUndefined();
  });

  it('keeps the version it names and marks it a range; a version file is still a pin', () => {
    const app = repoWith({ 'package.json': '{"engines":{"node":">=18"}}', 'pyproject.toml': 'requires-python = ">=3.10,<4"' });
    expect(versionsAskedIn(app)).toEqual({ node: '18', python: '3.10' });
    expect(rangesAskedIn(app)).toEqual({ node: '>=18', python: '>=3.10,<4' });
    expect(rangesAskedIn(repoWith({ '.nvmrc': '22', 'package.json': '{"engines":{"node":">=18"}}' }))).toEqual({});
    expect(rangesAskedIn(repoWith({ 'package.json': '{"engines":{"node":"latest-lts 18"}}' }))).toEqual({});
  });

  it('raises no gap when an installed version meets the range, and runs get it', () => {
    const app = repoWith({ 'package.json': '{"engines":{"node":">=18"}}' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '22')] });
    expect(tc.usesAt(app)).toEqual([{ kit: 'node', label: 'Node.js', asked: '18', range: '>=18', got: '22', from: 'default' }]);
    expect(tc.gapsByRepo()).toEqual({});
    expect(tc.askedByRepos()).toEqual({ app: { node: '22' } });
    expect(tc.env({ PATH: '/bin' }, app).PATH).toBe('/tc/node-22/bin:/bin');
  });

  it('picks the newest installed version the range allows over a default it doesn’t', () => {
    const app = repoWith({ 'package.json': '{"engines":{"node":"^20.11 || ^22"}}' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '18'), installed('node', '22'), installed('node', '24')], defaults: { node: '18' } });
    expect(tc.usesAt(app)).toEqual([expect.objectContaining({ got: '22', from: 'repo' })]);
    expect(tc.usesAt(app)[0].gap).toBeUndefined();
    expect(tc.env({}, app).PATH).toBe('/tc/node-22/bin');
  });

  it('still takes the exact version it names when that one is installed', () => {
    const app = repoWith({ 'package.json': '{"engines":{"node":">=18"}}' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '18'), installed('node', '22')], defaults: { node: '22' } });
    expect(tc.usesAt(app)).toEqual([expect.objectContaining({ got: '18', from: 'repo' })]);
  });

  it('names the range in a gap when nothing installed meets it, and offers a version that does', () => {
    const app = repoWith({ 'package.json': '{"engines":{"node":">=24"}}' });
    const tc = service([{ name: 'app', path: app }], { toolchains: [installed('node', '20')] });
    expect(tc.usesAt(app)).toEqual([
      expect.objectContaining({ asked: '24', range: '>=24', got: '20', from: 'default', install: '24', gap: 'the repo asks for Node.js >=24, which isn’t installed, so runs get Node.js 20' }),
    ]);
    expect(tc.askedByRepos()).toEqual({ app: { node: '>=24' } });
    const none = service([{ name: 'app', path: app }], {});
    expect(none.usesAt(app)[0]).toMatchObject({ gap: 'Node.js >=24 is needed and no Node.js is installed', install: '24' });
    const py = repoWith({ 'pyproject.toml': 'requires-python = ">3.10"' });
    expect(service([{ name: 'py', path: py }], {}).usesAt(py)[0]).toMatchObject({ asked: '3.10', range: '>3.10', install: '3.14' });
  });
});

describe('installing Gradle', () => {
  it('takes the latest final release of the major, checks its sha256 and unpacks the zip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-gradle-'));
    dirs.push(dir);
    const zip = Buffer.from('zip bytes');
    const sum = (await import('node:crypto')).createHash('sha256').update(zip).digest('hex');
    const versions = [
      { version: '9.0-rc-1', downloadUrl: 'x', checksumUrl: 'x', rcFor: '9.0' },
      { version: '8.14.3', downloadUrl: 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip', checksumUrl: 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256' },
      { version: '8.14.2', downloadUrl: 'y', checksumUrl: 'y' },
    ];
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      if (url.endsWith('/versions/all')) return new Response(JSON.stringify(versions));
      if (url.endsWith('.sha256')) return new Response(sum);
      return new Response(zip);
    }) as typeof fetch;
    let s: ToolchainState = { toolchains: [], defaults: {}, repoPicks: {} };
    const extracted: string[] = [];
    const tc = new ToolchainService({
      dir,
      store: { load: () => s, save: (v) => (s = v) },
      repos: () => [],
      fetchImpl,
      extract: async (_a, d) => {
        extracted.push(d);
        fs.mkdirSync(path.join(d, 'gradle-8.14.3', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(d, 'gradle-8.14.3', 'bin', 'gradle'), '');
      },
      probe: async () => 'Gradle 8.14.3',
    });
    const res = tc.install('gradle', '8', 'Bo');
    expect(res.ok).toBe(true);
    if (res.ok) await res.done;
    expect(fetched).toContain('https://services.gradle.org/distributions/gradle-8.14.3-bin.zip');
    expect(s.toolchains[0]).toMatchObject({ id: 'gradle-8', status: 'ready', detail: 'Gradle 8.14.3' });
    expect(s.toolchains[0].home).toBe(path.join(dir, 'gradle-8', 'gradle-8.14.3'));
    expect(tc.env({ PATH: '/bin' }).GRADLE_HOME).toBe(path.join(dir, 'gradle-8', 'gradle-8.14.3'));
  });
});
