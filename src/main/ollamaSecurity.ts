// Ollama update + security posture. We never upgrade behind the user's back —
// a local model server is theirs, not ours — but we do say when the installed
// build is behind the latest stable release and when the API is listening
// somewhere it shouldn't be.
//
// The freshness signal is the live GitHub release feed, not a hardcoded list:
// Ollama publishes no repo-level security advisories (the GitHub advisories
// endpoint for ollama/ollama is empty), so a checked-in CVE table would be the
// only thing standing between the user and a year-old server, and it would rot.
// OFFLINE_ADVISORIES is a floor for the offline case only.

import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { OllamaSecurityFinding, OllamaSecurityReport } from '../shared/types';
import { isOlder, parseSemver } from './semver';
import { runInTerminal } from './terminal';

const OLLAMA_PORT = 11434;
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const RELEASE_URL = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const RELEASE_TIMEOUT_MS = 4_000;
const BINARY_VERSION_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/// Being this many minor versions behind stops being "there's an update" and
/// starts being "you are running unpatched code".
const STALE_MINOR_GAP = 3;

interface Advisory {
  id: string;
  fixedIn: string;
  severity: 'critical' | 'high';
  summary: string;
  url: string;
}

/// Offline floor only — every one of these is cleared by 0.1.46, which is far
/// below any release a user would install today. Do not treat this as a
/// current CVE list; the release-feed comparison is what keeps people safe.
export const OFFLINE_ADVISORIES: Advisory[] = [
  {
    id: 'CVE-2024-37032',
    fixedIn: '0.1.34',
    severity: 'critical',
    summary: 'Path traversal in model manifest handling allows remote code execution ("Probllama").',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-37032',
  },
  {
    id: 'CVE-2024-39722',
    fixedIn: '0.1.46',
    severity: 'high',
    summary: 'Path traversal in /api/push discloses files on the host.',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-39722',
  },
  {
    id: 'CVE-2024-39720',
    fixedIn: '0.1.46',
    severity: 'high',
    summary: 'Out-of-bounds read in /api/create crashes the server.',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-39720',
  },
  {
    id: 'CVE-2024-39721',
    fixedIn: '0.1.46',
    severity: 'high',
    summary: 'Resource exhaustion via /api/create hangs the server.',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-39721',
  },
];

/// The release lookup is a network call, the binary read spawns a child
/// process, and the LAN probe is a handful of HTTP round-trips — none of them
/// change more than once in a great while, so all three share one TTL.
/// Refreshing them on every poll tick instead (LocalPane polls every 4s while
/// the server isn't confirmed running) would mean spawning `ollama --version`
/// every few seconds for an answer that changes when the user updates Ollama.
interface AuditCache {
  at: number;
  latestVersion: string | null;
  binaryVersion: string | null;
  lanExposed: boolean;
}
let cache: AuditCache | null = null;

/// Read the version off the binary. `ollama --version` EXITS 1 when no server
/// is listening (it warns about the missing instance and still prints the
/// client version), so exit status is deliberately ignored here — we only
/// care whether a version triple appeared on either stream.
///
/// Async on purpose: this runs in the Electron MAIN process, where a
/// spawnSync would freeze every window and every other IPC handler for as
/// long as the child took to answer. stdin is closed so a binary that
/// decides to prompt can never hold the read open.
export function readOllamaBinaryVersion(binaryPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: BINARY_VERSION_TIMEOUT_MS,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    // Optional chaining because the inline stdio tuple doesn't narrow spawn's
    // return type to ChildProcessByStdio — same reason ollama.ts casts.
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => (out += c));
    child.stderr?.on('data', (c: string) => (out += c));
    child.on('error', () => resolve(undefined));
    child.on('close', () =>
      resolve(parseSemver(out) ? out.match(/\d+\.\d+\.\d+/)![0] : undefined),
    );
  });
}

/// Latest STABLE tag (the /latest endpoint skips prereleases). Best-effort:
/// resolves null on any network or parse failure.
export function fetchLatestOllamaVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      RELEASE_URL,
      {
        timeout: RELEASE_TIMEOUT_MS,
        headers: { 'User-Agent': 'overcli', Accept: 'application/vnd.github+json' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const m = String(JSON.parse(data).tag_name ?? '').match(/\d+\.\d+\.\d+/);
            resolve(m ? m[0] : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/// True if the Ollama port answers on a non-loopback address of this machine —
/// i.e. anyone on the same network can drive the API, which has no auth.
/// Probes every non-internal IPv4 address, not just the first: a VPN/utun
/// interface commonly sorts ahead of the LAN-facing one, and only checking
/// the first address would miss real exposure on the others.
export function probeLanExposure(): Promise<boolean> {
  const addrs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  if (addrs.length === 0) return Promise.resolve(false);
  return Promise.all(addrs.map(probeOllamaVersionAt)).then((results) => results.some(Boolean));
}

/// True only if `host:OLLAMA_PORT` answers /api/version with Ollama's own
/// `{version}` shape — a bare 2xx isn't enough, since some other service
/// could be listening on 11434 and we'd rather under- than over-report a
/// critical-severity finding.
function probeOllamaVersionAt(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port: OLLAMA_PORT, path: '/api/version', timeout: 800 },
      (res) => {
        if (res.statusCode == null || res.statusCode >= 300) {
          res.resume();
          resolve(false);
          return;
        }
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(typeof JSON.parse(data)?.version === 'string');
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/// Pure rule engine — no I/O, so it is directly unit-testable.
export function buildFindings(input: {
  installedVersion?: string;
  latestVersion?: string;
  env: NodeJS.ProcessEnv;
  lanExposed: boolean;
  serverRunning: boolean;
  serverManaged: boolean;
}): OllamaSecurityFinding[] {
  const findings: OllamaSecurityFinding[] = [];
  const { installedVersion, latestVersion, env, lanExposed, serverRunning, serverManaged } = input;

  if (installedVersion) {
    for (const a of OFFLINE_ADVISORIES) {
      if (isOlder(installedVersion, a.fixedIn)) {
        findings.push({
          id: a.id,
          severity: a.severity,
          title: `${a.id} affects Ollama ${installedVersion}`,
          detail: `${a.summary} Fixed in ${a.fixedIn}.`,
          fixId: 'update-ollama',
          url: a.url,
        });
      }
    }
  }

  if (installedVersion && latestVersion && isOlder(installedVersion, latestVersion)) {
    const a = parseSemver(installedVersion);
    const b = parseSemver(latestVersion);
    // Same major, several minors behind → unpatched, not merely old.
    const stale = !!a && !!b && a[0] === b[0] && b[1] - a[1] >= STALE_MINOR_GAP;
    findings.push({
      id: 'outdated',
      severity: stale ? 'high' : 'medium',
      title: `Ollama ${installedVersion} is behind ${latestVersion}`,
      detail: stale
        ? `You are ${b![1] - a![1]} minor releases behind. Ollama ships security fixes in ordinary releases without CVE numbers, so a gap this size means known bugs are unpatched.`
        : 'A newer stable release is available. Ollama ships security fixes in ordinary releases, often without a CVE number.',
      fixId: 'update-ollama',
    });
  }

  // Environment findings describe a server we did NOT spawn. Our own child is
  // launched with OLLAMA_HOST/OLLAMA_ORIGINS forced to loopback, so reporting
  // the parent process's wildcard vars against it would be a finding that no
  // fix could ever clear.
  if (serverRunning && !serverManaged) {
    const host = env.OLLAMA_HOST ?? '';
    if (/0\.0\.0\.0|\[::\]|^:\d+$/.test(host)) {
      findings.push({
        id: 'host-wildcard',
        severity: 'high',
        title: `OLLAMA_HOST is set to "${host}"`,
        detail: 'This binds the model server to every interface. Anyone who can reach this machine can run, pull and delete your models. Set it back to loopback and restart Ollama.',
        manualCommand: 'launchctl unsetenv OLLAMA_HOST   # then quit and reopen Ollama',
      });
    }
    const origins = env.OLLAMA_ORIGINS ?? '';
    if (origins.split(',').some((o) => o.trim() === '*')) {
      findings.push({
        id: 'origins-wildcard',
        severity: 'high',
        title: 'OLLAMA_ORIGINS allows every origin',
        detail: 'Any web page you visit can call your local model server from your browser. Restrict it to loopback origins and restart Ollama.',
        manualCommand: 'launchctl unsetenv OLLAMA_ORIGINS   # then quit and reopen Ollama',
      });
    }
  }

  // Observed exposure, as opposed to inferred — always worth reporting.
  if (lanExposed) {
    findings.push({
      id: 'lan-exposed',
      severity: 'critical',
      title: 'The Ollama API answers on your local network',
      detail: `Port ${OLLAMA_PORT} responded on a non-loopback address. The API has no authentication.`,
      fixId: serverManaged ? 'restart-loopback' : undefined,
      manualCommand: serverManaged ? undefined : 'OLLAMA_HOST=127.0.0.1:11434 ollama serve',
    });
  }

  return findings;
}

/// Full audit. Prefers the running server's version and falls back to the
/// cached binary read, so a stopped server still gets a real answer.
export async function auditOllama(args: {
  serverVersion?: string;
  binaryPath?: string;
  serverRunning: boolean;
  serverManaged: boolean;
  force?: boolean;
}): Promise<OllamaSecurityReport> {
  const now = Date.now();
  if (args.force || !cache || now - cache.at > CACHE_TTL_MS) {
    const [latestVersion, binaryVersion, lanExposed] = await Promise.all([
      fetchLatestOllamaVersion(),
      args.binaryPath ? readOllamaBinaryVersion(args.binaryPath) : Promise.resolve(undefined),
      probeLanExposure(),
    ]);
    cache = { at: now, latestVersion, binaryVersion: binaryVersion ?? null, lanExposed };
  }

  let installedVersion = args.serverVersion;
  let versionSource: 'server' | 'binary' | 'unknown' = installedVersion ? 'server' : 'unknown';
  if (!installedVersion && cache.binaryVersion) {
    installedVersion = cache.binaryVersion;
    versionSource = 'binary';
  }
  const latestVersion = cache.latestVersion ?? undefined;

  return {
    installedVersion,
    latestVersion,
    versionSource,
    updateAvailable: !!installedVersion && !!latestVersion && isOlder(installedVersion, latestVersion),
    // The underlying probes only ran if the cache was refreshed above — report
    // when that actually happened, not `now`, or a cache hit would claim data
    // up to CACHE_TTL_MS old was checked this instant.
    checkedAt: cache.at,
    findings: buildFindings({
      installedVersion,
      latestVersion,
      env: process.env,
      lanExposed: cache.lanExposed,
      serverRunning: args.serverRunning,
      serverManaged: args.serverManaged,
    }),
  };
}

/// Starts an update. When Homebrew is the thing that installed Ollama we run
/// `brew upgrade ollama` in a visible Terminal so the user can watch it work
/// or fail; everywhere else we open the download page. We never swap the
/// binary ourselves.
///
/// `brewManaged` must mean "brew owns this Ollama", not merely "brew exists":
/// running `brew upgrade ollama` against a .dmg install just prints
/// `Error: ollama not installed` into a window the user has to decipher.
export async function updateOllama(
  opener: (url: string) => void,
  brewManaged: boolean,
): Promise<{ ok: boolean; message: string; command?: string }> {
  if (process.platform === 'darwin' && brewManaged) {
    const command = 'brew upgrade ollama';
    const res = await runInTerminal(command);
    if (res.ok) return { ok: true, message: `Opened Terminal running \`${command}\`.` };
    // The launch failed. Say so instead of claiming a window opened, and hand
    // back the command so the UI can offer it to copy.
    return { ok: false, message: res.error, command: res.command ?? command };
  }
  opener(OLLAMA_DOWNLOAD_URL);
  return { ok: true, message: 'Opened the Ollama download page — install over your existing copy.' };
}
