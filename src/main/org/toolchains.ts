// Build tools the server's workers and repo tests run with, installed from
// the console instead of baked into the image.
//
// A hosted server runs as an unprivileged user in a slim image: Node and git,
// no JDK, no Go, no root to apt-get one. What it does have is its data
// volume, which survives restarts and upgrades. So an admin ticks "Java 8"
// or "Node 20" on Setup → Toolchains, the server downloads the official
// build for its own OS and CPU into <data>/toolchains/<kit>-<version>,
// checks its checksum and that it runs, and from then on every worker's
// shell and every repo test command has it on PATH (and JAVA_HOME / GOROOT
// where the kit has one).
//
// Which version a run gets, per kit: the repo's pick on that page, else what
// the repo itself asks for (.nvmrc, .python-version, .sdkmanrc, go.mod,
// .tool-versions) when that version is installed, else the kit's default.
// Which repo a run is in comes from its folder's `.git`: a worktree's names
// the clone it was forked from (`gitdir: <clone>/.git/worktrees/<name>`).
//
// Custom kits are any .tar.gz an admin points at: for what the catalog
// doesn't carry. They run on the server like everything else here, so only
// admins add them, over https, ideally with a sha256.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type KitId = 'java' | 'node' | 'python' | 'go' | 'gradle' | 'custom';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type Fetch = typeof fetch;

/// One download: where, what it should hash to, and the version it is.
interface Download {
  url: string;
  sha256?: string;
  label: string;
}

interface Platform {
  platform: NodeJS.Platform;
  arch: string;
}

export interface KitDef {
  id: Exclude<KitId, 'custom'>;
  label: string;
  source: string;
  versions: readonly string[];
  /// Set to the picked version's home, beside PATH.
  homeVar?: string;
  /// The binary that shows it runs, and how to ask its version.
  probe: { bin: string; args: string[] };
}

export const KITS: readonly KitDef[] = [
  { id: 'java', label: 'Java', source: 'Amazon Corretto', versions: ['8', '11', '17', '21', '25'], homeVar: 'JAVA_HOME', probe: { bin: 'java', args: ['-version'] } },
  { id: 'node', label: 'Node.js', source: 'nodejs.org', versions: ['18', '20', '22', '24', '26'], probe: { bin: 'node', args: ['--version'] } },
  { id: 'python', label: 'Python', source: 'python-build-standalone, through uv', versions: ['3.9', '3.10', '3.11', '3.12', '3.13', '3.14'], probe: { bin: 'python3', args: ['--version'] } },
  { id: 'go', label: 'Go', source: 'go.dev', versions: ['1.22', '1.23', '1.24', '1.25', '1.26'], homeVar: 'GOROOT', probe: { bin: 'go', args: ['version'] } },
  // For repos without the wrapper: a repo with gradlew fetches its own
  // Gradle into ~/.gradle and needs only Java. Runs on the installed Java.
  { id: 'gradle', label: 'Gradle', source: 'services.gradle.org', versions: ['7', '8', '9'], homeVar: 'GRADLE_HOME', probe: { bin: 'gradle', args: ['--version'] } },
];

const kitDef = (id: string): KitDef | undefined => KITS.find((k) => k.id === id);

export interface CustomKit {
  url: string;
  sha256?: string;
  /// The folder inside it that goes on PATH, from its top: `bin`.
  bin: string;
  /// Extra variables; `{home}` in a value is where it was unpacked.
  env: Record<string, string>;
}

export interface Toolchain {
  /// `java-8`, `node-20`, `custom-terraform`: also its folder.
  id: string;
  kit: KitId;
  /// The kit's version (`8`, `3.12`), or a custom kit's name.
  version: string;
  status: 'installing' | 'ready' | 'failed';
  /// What it said when asked its version, once it runs.
  detail?: string;
  error?: string;
  /// Where it was unpacked (JAVA_HOME, GOROOT, `{home}`).
  home?: string;
  custom?: CustomKit;
  by: string;
  at: number;
}

export interface ToolchainState {
  toolchains: Toolchain[];
  /// Kit → version where nothing more specific says: the first installed,
  /// until an admin picks another.
  defaults: Partial<Record<KitId, string>>;
  /// Repo name → kit → version its runs and tests use.
  repoPicks: Record<string, Partial<Record<KitId, string>>>;
}

export interface ToolchainDeps {
  dir: string;
  store: { load(): ToolchainState; save(value: ToolchainState): void };
  /// Connected repos, to tell which one a run's folder belongs to.
  repos(): Array<{ name: string; path: string }>;
  fetchImpl?: Fetch;
  /// Unpack an archive into `dest` as it is.
  extract?(archive: string, dest: string): Promise<void>;
  /// Install a Python into `dir` (uv's --install-dir).
  uvInstall?(version: string, dir: string): Promise<void>;
  /// Run a binary to see it works; what it printed.
  probe?(bin: string, args: string[]): Promise<string>;
  platform?: NodeJS.Platform;
  arch?: string;
  now?(): number;
  log?(message: string): void;
}

/// The most a download may be, and take: a JDK is ~200 MB; an address that
/// streams without end must not fill the volume the worktrees live on.
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/// Passes bytes through until there are too many.
function capped(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      done(seen > max ? new Error(`It is over ${Math.round(max / 1024 / 1024)} MB, so nothing was installed.`) : null, chunk);
    },
  });
}

const run = (file: string, args: string[], timeout = 5 * 60_000, env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => (err ? reject(new Error(`${stderr}`.trim() || err.message)) : resolve(`${stderr}${stdout}`))),
  );

const sha256Of = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};

const fetchText = async (fetchImpl: Fetch, url: string): Promise<string> => {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  return res.text();
};

// ---- where each kit's build comes from -------------------------------------

export function correttoUrl(version: string, p: Platform): Result<{ url: string; sumUrl: string }> {
  const os = p.platform === 'linux' ? 'linux' : p.platform === 'darwin' ? 'macos' : null;
  const cpu = p.arch === 'x64' ? 'x64' : p.arch === 'arm64' ? 'aarch64' : null;
  if (!os || !cpu) return { ok: false, error: `No Corretto build for ${p.platform} on ${p.arch}.` };
  const file = `amazon-corretto-${version}-${cpu}-${os}-jdk.tar.gz`;
  return { ok: true, url: `https://corretto.aws/downloads/latest/${file}`, sumUrl: `https://corretto.aws/downloads/latest_sha256/${file}` };
}

const nodeOs = (p: Platform) => (p.platform === 'linux' ? 'linux' : p.platform === 'darwin' ? 'darwin' : null);
const nodeCpu = (p: Platform) => (p.arch === 'x64' ? 'x64' : p.arch === 'arm64' ? 'arm64' : null);
const goCpu = (p: Platform) => (p.arch === 'x64' ? 'amd64' : p.arch === 'arm64' ? 'arm64' : null);

async function resolveDownload(kit: KitDef['id'], version: string, p: Platform, fetchImpl: Fetch): Promise<Download> {
  if (kit === 'java') {
    const c = correttoUrl(version, p);
    if (!c.ok) throw new Error(c.error);
    const sum = (await fetchText(fetchImpl, c.sumUrl).catch(() => '')).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/i.test(sum)) throw new Error(`Couldn't get the checksum for Java ${version} from corretto.aws, so nothing was installed. Try again later.`);
    return { url: c.url, sha256: sum.toLowerCase(), label: `Java ${version}` };
  }
  if (kit === 'node') {
    const os = nodeOs(p);
    const cpu = nodeCpu(p);
    if (!os || !cpu) throw new Error(`No Node.js build for ${p.platform} on ${p.arch}.`);
    const index = JSON.parse(await fetchText(fetchImpl, 'https://nodejs.org/dist/index.json')) as Array<{ version: string }>;
    const latest = index.find((r) => r.version.startsWith(`v${version}.`))?.version;
    if (!latest) throw new Error(`nodejs.org has no Node ${version} release.`);
    const file = `node-${latest}-${os}-${cpu}.tar.gz`;
    const sums = await fetchText(fetchImpl, `https://nodejs.org/dist/${latest}/SHASUMS256.txt`);
    const sum = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((parts) => parts[1] === file)?.[0];
    if (!sum) throw new Error(`nodejs.org lists no checksum for ${file}, so nothing was installed.`);
    return { url: `https://nodejs.org/dist/${latest}/${file}`, sha256: sum, label: `Node ${latest}` };
  }
  if (kit === 'go') {
    const os = nodeOs(p);
    const cpu = goCpu(p);
    if (!os || !cpu) throw new Error(`No Go build for ${p.platform} on ${p.arch}.`);
    const releases = JSON.parse(await fetchText(fetchImpl, 'https://go.dev/dl/?mode=json&include=all')) as Array<{ version: string; stable: boolean; files: Array<{ filename: string; os: string; arch: string; kind: string; sha256: string }> }>;
    const rel = releases.find((r) => r.stable && (r.version === `go${version}` || r.version.startsWith(`go${version}.`)));
    const file = rel?.files.find((f) => f.os === os && f.arch === cpu && f.kind === 'archive');
    if (!rel || !file) throw new Error(`go.dev has no Go ${version} build for ${os}/${cpu}.`);
    return { url: `https://go.dev/dl/${file.filename}`, sha256: file.sha256, label: rel.version };
  }
  if (kit === 'gradle') {
    // Newest first; the latest final release of that major.
    const all = JSON.parse(await fetchText(fetchImpl, 'https://services.gradle.org/versions/all')) as Array<{ version: string; downloadUrl: string; checksumUrl: string; snapshot?: boolean; nightly?: boolean; broken?: boolean; rcFor?: string; milestoneFor?: string }>;
    const rel = all.find((r) => !r.snapshot && !r.nightly && !r.broken && !r.rcFor && !r.milestoneFor && (r.version === version || r.version.startsWith(`${version}.`)));
    if (!rel) throw new Error(`services.gradle.org has no Gradle ${version} release.`);
    const sum = (await fetchText(fetchImpl, rel.checksumUrl).catch(() => '')).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/i.test(sum)) throw new Error(`Couldn't get the checksum for Gradle ${rel.version}, so nothing was installed. Try again later.`);
    return { url: rel.downloadUrl, sha256: sum.toLowerCase(), label: `Gradle ${rel.version}` };
  }
  throw new Error(`${kit} isn't downloaded directly.`);
}

// ---- what a repo asks for itself -------------------------------------------

const major = (v: string) => /^(\d+)/.exec(v.replace(/^v/i, ''))?.[1];
const javaMajor = (v: string) => {
  const m = /(\d+)(?:\.(\d+))?/.exec(v);
  if (!m) return undefined;
  return m[1] === '1' && m[2] ? m[2] : m[1];
};
const majorMinor = (v: string) => /(\d+\.\d+)/.exec(v)?.[1];

/// The versions a repo's own files ask for, normalised to the catalog's
/// form (`8`, `20`, `3.12`, `1.22`).
export function versionsAskedIn(root: string): Partial<Record<KitId, string>> {
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      return undefined;
    }
  };
  const out: Partial<Record<KitId, string>> = {};
  const set = (kit: KitId, v: string | undefined) => {
    if (v && !out[kit]) out[kit] = v;
  };
  for (const line of (read('.tool-versions') ?? '').split('\n')) {
    const [tool, v] = line.trim().split(/\s+/);
    if (!tool || !v || tool.startsWith('#')) continue;
    if (tool === 'nodejs' || tool === 'node') set('node', major(v));
    if (tool === 'python') set('python', majorMinor(v));
    if (tool === 'java') set('java', javaMajor(v));
    if (tool === 'golang' || tool === 'go') set('go', majorMinor(v));
  }
  for (const f of ['.nvmrc', '.node-version']) {
    const v = read(f)?.trim();
    if (v) set('node', /^lts\//i.test(v) ? NODE_LTS[v.slice(4).toLowerCase()] : major(v));
  }
  set('python', majorMinor(read('.python-version')?.split('\n')[0] ?? ''));
  const sdk = /^java=(.+)$/m.exec(read('.sdkmanrc') ?? '')?.[1];
  if (sdk) set('java', javaMajor(sdk));
  const jv = read('.java-version')?.trim();
  if (jv) set('java', javaMajor(jv));
  set('go', /^go\s+(\d+\.\d+)/m.exec(read('go.mod') ?? '')?.[1]);
  // Then what a build file or manifest says, when no version file did.
  try {
    const engines = (JSON.parse(read('package.json') ?? '{}') as { engines?: { node?: unknown } }).engines?.node;
    if (typeof engines === 'string') set('node', /\d+/.exec(engines)?.[0]);
  } catch {
    // not JSON: nothing asked
  }
  const gradle = `${read('build.gradle') ?? ''}\n${read('build.gradle.kts') ?? ''}`;
  const toolchain = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(gradle)?.[1];
  const compat = /(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?['"]?(\d+(?:[._]\d+)?)/.exec(gradle)?.[1]?.replace('_', '.');
  set('java', javaMajor(toolchain ?? compat ?? ''));
  set('java', javaMajor(/<(?:maven\.compiler\.release|java\.version|maven\.compiler\.source|release)>\s*([\d.]+)\s*</.exec(read('pom.xml') ?? '')?.[1] ?? ''));
  set('python', majorMinor(/requires-python\s*=\s*["'][^"']*?(\d+\.\d+)/.exec(read('pyproject.toml') ?? '')?.[1] ?? ''));
  return out;
}

/// `lts/<codename>` in an .nvmrc, to its major. `lts/*` names no one version.
export const NODE_LTS: Record<string, string> = {
  argon: '4', boron: '6', carbon: '8', dubnium: '10', erbium: '12', fermium: '14', gallium: '16', hydrogen: '18', iron: '20', jod: '22', krypton: '24',
};

/// The kits a repo builds with, from the files at its top, whether or not
/// it says which version.
export function kitsNeededIn(root: string): Set<Exclude<KitId, 'custom'>> {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const any = (fs_: string[]) => fs_.some(has);
  const out = new Set<Exclude<KitId, 'custom'>>();
  const gradleBuild = any(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
  if (any(['package.json', '.nvmrc', '.node-version'])) out.add('node');
  if (gradleBuild || any(['pom.xml', '.java-version', '.sdkmanrc'])) out.add('java');
  // The wrapper fetches its own Gradle; without one, Gradle must be here.
  if (gradleBuild && !has('gradlew')) out.add('gradle');
  if (any(['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', '.python-version'])) out.add('python');
  if (has('go.mod')) out.add('go');
  for (const k of Object.keys(versionsAskedIn(root)) as Array<Exclude<KitId, 'custom'>>) out.add(k);
  return out;
}

/// One kit a repo builds with: what it asks for, what a run there gets, and
/// what's wrong, if anything.
export interface KitUse {
  kit: Exclude<KitId, 'custom'>;
  label: string;
  asked?: string;
  got?: string;
  /// Where `got` came from: the admin's pick for the repo, the repo's own
  /// files, or the server's default.
  from?: 'pick' | 'repo' | 'default';
  /// In words, when a run doesn't get what the repo needs.
  gap?: string;
  /// The catalog version that would close the gap.
  install?: string;
}

/// What the worker is told about its build tools, from usesAt.
export function toolchainNote(uses: KitUse[], where = ''): string[] {
  const why = { pick: 'set for this repo', repo: 'as the repo asks', default: 'the server default' } as const;
  const on = uses.filter((u) => u.got).map((u) => `${u.label} ${u.got} (${why[u.from!]})`);
  const lines = [
    `${on.length ? `Build tools on PATH${where}: ${on.join(', ')}. ` : ''}There is no nvm, sdkman or pyenv here, and none is needed; do not try to install toolchains.`,
  ];
  for (const u of uses.filter((x) => x.gap)) lines.push(`Missing${where}: ${u.gap}. If your change needs it, say so plainly in your reply: an admin installs it on Setup → Toolchains.`);
  return lines;
}

// ---- custom kits -----------------------------------------------------------

const CUSTOM_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/// Not for a custom kit to set: what decides where everything else runs from.
const ENV_RESERVED = /^(PATH|HOME|USER|SHELL|LD_.*|DYLD_.*|NODE_OPTIONS|OVERCLI_.*)$/;

export function checkCustom(input: { name?: string; url?: string; sha256?: string; bin?: string; env?: Record<string, string> }): Result<{ name: string; custom: CustomKit }> {
  const name = (input.name ?? '').trim().toLowerCase();
  if (!CUSTOM_NAME.test(name)) return { ok: false, error: 'Name it with lowercase letters, digits and dashes, like terraform.' };
  let url: URL;
  try {
    url = new URL((input.url ?? '').trim());
  } catch {
    return { ok: false, error: 'Give the address of a .tar.gz or .tar.xz.' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Use an https address.' };
  const sha256 = input.sha256?.trim().toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) return { ok: false, error: 'The sha256 is 64 hex characters.' };
  const bin = (input.bin ?? 'bin').trim().replace(/^\/+|\/+$/g, '');
  if (bin.split('/').some((s) => s === '..')) return { ok: false, error: 'The bin folder is inside the archive.' };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!ENV_NAME.test(k)) return { ok: false, error: `${k} isn't a variable name.` };
    if (ENV_RESERVED.test(k)) return { ok: false, error: `A custom kit can't set ${k}.` };
    env[k] = String(v);
  }
  return { ok: true, name, custom: { url: url.toString(), ...(sha256 ? { sha256 } : {}), bin, env } };
}

// ---- the service -----------------------------------------------------------

export class ToolchainService {
  constructor(private readonly deps: ToolchainDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private platform(): Platform {
    return { platform: this.deps.platform ?? process.platform, arch: this.deps.arch ?? process.arch };
  }

  private load(): ToolchainState {
    const s = this.deps.store.load();
    return { toolchains: s.toolchains ?? [], defaults: s.defaults ?? {}, repoPicks: s.repoPicks ?? {} };
  }

  private patch(id: string, patch: Partial<Toolchain>): void {
    const s = this.load();
    s.toolchains = s.toolchains.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.deps.store.save(s);
  }

  state(): ToolchainState {
    return this.load();
  }

  /// At start: a download the last process didn't finish never will.
  recover(): void {
    const s = this.load();
    if (!s.toolchains.some((t) => t.status === 'installing')) return;
    s.toolchains = s.toolchains.map((t) => (t.status === 'installing' ? { ...t, status: 'failed', error: 'The server restarted while it was downloading. Install it again.' } : t));
    this.deps.store.save(s);
  }

  /// Start installing a catalog version, or a custom kit; it finishes in the
  /// background (`done`, for tests).
  install(
    kit: string,
    version: string,
    by: string,
    custom?: { url?: string; sha256?: string; bin?: string; env?: Record<string, string> },
  ): Result<{ toolchain: Toolchain; done: Promise<void> }> {
    let id: string;
    let checked: CustomKit | undefined;
    if (kit === 'custom') {
      const c = checkCustom({ name: version, ...custom });
      if (!c.ok) return c;
      version = c.name;
      checked = c.custom;
      id = `custom-${version}`;
    } else {
      const def = kitDef(kit);
      if (!def) return { ok: false, error: `There's no ${kit} kit.` };
      if (!def.versions.includes(version)) return { ok: false, error: `${def.label} ${version} isn't offered. Pick one of ${def.versions.join(', ')}.` };
      id = `${kit}-${version}`;
    }
    const s = this.load();
    const previous = s.toolchains.find((t) => t.id === id);
    if (previous?.status === 'installing') return { ok: false, error: 'That one is already installing.' };
    const toolchain: Toolchain = { id, kit: kit as KitId, version, status: 'installing', ...(checked ? { custom: checked } : {}), by, at: this.now() };
    s.toolchains = [...s.toolchains.filter((t) => t.id !== id), toolchain];
    this.deps.store.save(s);
    const done = this.put(toolchain).then(
      (got) => {
        this.patch(id, { status: 'ready', home: got.home, detail: got.detail, error: undefined });
        this.deps.log?.(`${id} is installed: ${got.detail}`);
      },
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        // A reinstall that failed left the working one in place: it stays
        // ready, with why the new one didn't take.
        if (previous?.status === 'ready' && previous.home && fs.existsSync(previous.home)) this.patch(id, { ...previous, error: `Reinstalling failed, so the installed one stays: ${error}`.slice(0, 500) });
        else this.patch(id, { status: 'failed', error: error.slice(0, 500) });
        this.deps.log?.(`${id} could not be installed: ${error}`);
      },
    );
    return { ok: true, toolchain, done };
  }

  /// Download (or have uv install) into a staging folder, check it, and swap
  /// it in whole, so a run never sees half a toolchain. One already there is
  /// set aside, not deleted, until the new one runs: a failed reinstall puts
  /// it back.
  private async put(t: Toolchain): Promise<{ home: string; detail: string }> {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const staging = path.join(this.deps.dir, `.${t.id}.partial`);
    const archive = path.join(this.deps.dir, `.${t.id}.archive`);
    const old = path.join(this.deps.dir, `.${t.id}.old`);
    const dest = path.join(this.deps.dir, t.id);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    let swapped = false;
    try {
      if (t.kit === 'python') {
        await (this.deps.uvInstall ?? ((v, d) => run('uv', ['python', 'install', '--install-dir', d, v], 15 * 60_000).then(() => undefined)))(t.version, staging);
      } else {
        const fetchImpl = this.deps.fetchImpl ?? fetch;
        const dl: Download = t.custom ? { url: t.custom.url, ...(t.custom.sha256 ? { sha256: t.custom.sha256 } : {}), label: t.version } : await resolveDownload(t.kit as KitDef['id'], t.version, this.platform(), fetchImpl);
        const res = await fetchImpl(dl.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok || !res.body) throw new Error(`Downloading ${dl.url} failed: HTTP ${res.status}.`);
        if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error(`${dl.url} is over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB, so nothing was installed.`);
        await pipeline(Readable.fromWeb(res.body as never), capped(MAX_DOWNLOAD_BYTES), fs.createWriteStream(archive));
        if (dl.sha256) {
          const got = await sha256Of(archive);
          if (got !== dl.sha256) throw new Error(`${dl.url} doesn't match its sha256 (expected ${dl.sha256}, got ${got}). Nothing was installed.`);
        }
        // Gradle ships only as a zip, which GNU tar can't read.
        await (this.deps.extract ?? ((a, d) => (/\.zip$/i.test(dl.url) ? run('unzip', ['-q', a, '-d', d]) : run('tar', ['xf', a, '-C', d])).then(() => undefined)))(archive, staging);
      }
      if (fs.existsSync(dest)) fs.renameSync(dest, old);
      fs.renameSync(staging, dest);
      swapped = true;
      const home = this.homeIn(dest, t);
      const bin = this.binOf({ ...t, home });
      if (!fs.existsSync(bin)) throw new Error(`There's no ${path.relative(dest, bin) || 'bin'} folder in what it unpacked.`);
      const def = kitDef(t.kit);
      // With the toolchains on PATH: Gradle runs on the installed Java.
      const probe = this.deps.probe ?? ((b: string, a: string[]) => run(b, a, undefined, this.env(process.env)));
      const said = def
        ? await probe(path.join(bin, def.probe.bin), def.probe.args).catch((err: unknown) => {
            const noJava = t.kit === 'gradle' && !this.load().toolchains.some((x) => x.kit === 'java' && x.status === 'ready');
            throw noJava ? new Error('Gradle needs Java to run. Install a Java first, then Gradle again.') : err;
          })
        : 'Installed';
      return { home, detail: said.split('\n').map((l) => l.trim()).find(Boolean) ?? t.version };
    } catch (err) {
      if (swapped) fs.rmSync(dest, { recursive: true, force: true });
      if (fs.existsSync(old) && !fs.existsSync(dest)) fs.renameSync(old, dest);
      throw err;
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /// An archive's one top folder (`jdk8u432/`, `node-v20…/`, `go/`, uv's
  /// `cpython-3.12…/`) is its home; a Mac JDK's is Contents/Home inside it.
  private homeIn(dest: string, t: Toolchain): string {
    const entries = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    const dirs = entries.filter((e) => e.isDirectory());
    let home = dest;
    if (t.kit === 'python') {
      const py = dirs.find((d) => d.name.startsWith('cpython-'));
      if (py) home = path.join(dest, py.name);
    } else if (dirs.length === 1 && entries.length === 1) {
      home = path.join(dest, dirs[0].name);
    }
    const mac = path.join(home, 'Contents', 'Home');
    return t.kit === 'java' && fs.existsSync(mac) ? mac : home;
  }

  private binOf(t: Pick<Toolchain, 'home' | 'custom'>): string {
    return path.join(t.home!, t.custom ? t.custom.bin : 'bin');
  }

  remove(id: string): Result {
    const s = this.load();
    const t = s.toolchains.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'No toolchain by that name.' };
    if (t.status === 'installing') return { ok: false, error: 'It is still installing.' };
    const users = Object.entries(s.repoPicks).filter(([, picks]) => picks[t.kit] === t.version).map(([r]) => r);
    if (users.length) return { ok: false, error: `${users.join(', ')} ${users.length === 1 ? 'is' : 'are'} set to ${t.id}. Pick another for ${users.length === 1 ? 'it' : 'them'} first.` };
    fs.rmSync(path.join(this.deps.dir, t.id), { recursive: true, force: true });
    s.toolchains = s.toolchains.filter((x) => x.id !== id);
    if (s.defaults[t.kit] === t.version) delete s.defaults[t.kit];
    this.deps.store.save(s);
    return { ok: true };
  }

  private ready(s: ToolchainState, kit: KitId, version: string | undefined): Toolchain | undefined {
    return version === undefined ? undefined : s.toolchains.find((t) => t.kit === kit && t.version === version && t.status === 'ready' && t.home);
  }

  setDefault(kit: string, version: string): Result {
    const s = this.load();
    if (!kitDef(kit)) return { ok: false, error: `There's no ${kit} kit with versions to choose.` };
    if (!this.ready(s, kit as KitId, version)) return { ok: false, error: `Install ${kitDef(kit)!.label} ${version} first.` };
    s.defaults[kit as KitId] = version;
    this.deps.store.save(s);
    return { ok: true };
  }

  /// `null`: the repo goes back to what it asks for, or the default.
  setRepoPick(repo: string, kit: string, version: string | null): Result {
    const s = this.load();
    if (!this.deps.repos().some((r) => r.name === repo)) return { ok: false, error: 'No repo by that name.' };
    if (!kitDef(kit)) return { ok: false, error: `There's no ${kit} kit with versions to choose.` };
    const picks = { ...(s.repoPicks[repo] ?? {}) };
    if (version === null) delete picks[kit as KitId];
    else if (!this.ready(s, kit as KitId, version)) return { ok: false, error: `Install ${kitDef(kit)!.label} ${version} first.` };
    else picks[kit as KitId] = version;
    if (Object.keys(picks).length) s.repoPicks[repo] = picks;
    else delete s.repoPicks[repo];
    this.deps.store.save(s);
    return { ok: true };
  }

  /// What each connected repo asks for in its own files, read from its clone.
  askedByRepos(): Record<string, Partial<Record<KitId, string>>> {
    return Object.fromEntries(this.deps.repos().map((r) => [r.name, versionsAskedIn(r.path)]));
  }

  /// The version of a kit a run gets: the repo's pick, else what it asks
  /// for when installed, else the default, else the first installed.
  private pickFor(s: ToolchainState, kit: Exclude<KitId, 'custom'>, repo: string | undefined, asked: string | undefined): { t: Toolchain; from: 'pick' | 'repo' | 'default' } | undefined {
    const picked = this.ready(s, kit, repo ? s.repoPicks[repo]?.[kit] : undefined);
    if (picked) return { t: picked, from: 'pick' };
    const theirs = this.ready(s, kit, asked);
    if (theirs) return { t: theirs, from: 'repo' };
    const fallback = this.ready(s, kit, s.defaults[kit]) ?? s.toolchains.find((t) => t.kit === kit && t.status === 'ready' && t.home);
    return fallback ? { t: fallback, from: 'default' } : undefined;
  }

  /// The kits the checkout at `cwd` builds with and what each gets. Only
  /// kits it uses; empty outside a connected repo.
  usesAt(cwd: string | undefined): KitUse[] {
    const at = this.repoAt(cwd);
    if (!at) return [];
    const s = this.load();
    const asked = versionsAskedIn(at.root);
    const needed = kitsNeededIn(at.root);
    return KITS.filter((def) => needed.has(def.id)).map((def): KitUse => {
      const a = asked[def.id];
      const p = this.pickFor(s, def.id, at.name, a);
      const offered = a !== undefined && def.versions.includes(a);
      const use: KitUse = { kit: def.id, label: def.label, ...(a ? { asked: a } : {}), ...(p ? { got: p.t.version, from: p.from } : {}) };
      if (!p) return { ...use, gap: a ? `${def.label} ${a} is needed and no ${def.label} is installed` : `${def.label} is needed and none is installed`, ...(offered ? { install: a } : {}) };
      // An admin's pick for the repo is deliberate: not a gap.
      if (a && p.from === 'default') {
        return { ...use, gap: `the repo asks for ${def.label} ${a}${offered ? ', which isn’t installed' : ', which the catalog doesn’t offer'}, so runs get ${def.label} ${p.t.version}`, ...(offered ? { install: a } : {}) };
      }
      return use;
    });
  }

  /// Per connected repo, the kits whose runs don't get what it needs.
  gapsByRepo(): Record<string, KitUse[]> {
    const out: Record<string, KitUse[]> = {};
    for (const r of this.deps.repos()) {
      const gaps = this.usesAt(r.path).filter((u) => u.gap);
      if (gaps.length) out[r.name] = gaps;
    }
    return out;
  }

  /// The connected repo a folder is in, and the top of its checkout there:
  /// the clone itself, or a worktree forked from it.
  repoAt(cwd: string | undefined): { name: string; root: string } | undefined {
    if (!cwd) return undefined;
    const repos = this.deps.repos();
    if (!repos.length) return undefined;
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const clones = repos.map((r) => ({ name: r.name, path: real(r.path) }));
    let dir = path.resolve(cwd);
    for (let i = 0; i < 40; i++) {
      const hit = clones.find((c) => c.path === real(dir));
      if (hit) return { name: hit.name, root: dir };
      const dotGit = path.join(dir, '.git');
      try {
        if (fs.statSync(dotGit).isFile()) {
          const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
          const clone = gitdir ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(path.resolve(dir, gitdir))?.[1] : undefined;
          const name = clone ? clones.find((c) => c.path === real(clone))?.name : undefined;
          return name ? { name, root: dir } : undefined;
        }
      } catch {
        // no .git here; keep climbing
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return undefined;
  }

  /// `env` as a run in `cwd` gets it: per kit, the repo's pick, else what the
  /// repo's files ask for if installed, else the default (else the first
  /// installed) on PATH and as its home variable; every custom kit too.
  env(env: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
    const s = this.load();
    const ready = s.toolchains.filter((t) => t.status === 'ready' && t.home);
    if (!ready.length) return env;
    const at = this.repoAt(cwd);
    const asked = at ? versionsAskedIn(at.root) : {};
    const out: NodeJS.ProcessEnv = { ...env };
    const bins: string[] = [];
    for (const def of KITS) {
      const pick = this.pickFor(s, def.id, at?.name, asked[def.id])?.t;
      if (!pick) continue;
      bins.push(this.binOf(pick));
      if (def.homeVar) out[def.homeVar] = pick.home;
    }
    for (const t of ready.filter((x) => x.kit === 'custom' && x.custom)) {
      bins.push(this.binOf(t));
      for (const [k, v] of Object.entries(t.custom!.env)) out[k] = v.split('{home}').join(t.home!);
    }
    const sep = this.platform().platform === 'win32' ? ';' : ':';
    out.PATH = [...new Set([...bins, ...(env.PATH ?? '').split(sep).filter(Boolean)])].join(sep);
    return out;
  }
}
