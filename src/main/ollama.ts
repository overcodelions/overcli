// Ollama integration. overcli talks to a locally-installed Ollama server
// (http://127.0.0.1:11434) — we don't bundle or redistribute weights.
// Users pull models themselves via `ollama pull`, which means they accept
// each model's license (Apache 2.0, Qwen Research, Meta CodeLlama, etc.)
// directly. Our job is to detect, surface, and make that setup easy.

import { spawn, spawnSync, ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runInTerminal } from './terminal';

export type OllamaTier = 'tiny' | 'small' | 'medium' | 'large';

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface OllamaDetection {
  installed: boolean;
  /// True if the Ollama HTTP server is answering on 127.0.0.1:11434.
  running: boolean;
  version?: string;
  binaryPath?: string;
  models: OllamaModel[];
  /// Populated when `installed` is false — URL the user can follow to
  /// install, or the package-manager command we'd run on their behalf.
  installHint?: { brewAvailable: boolean; downloadUrl: string };
}

export interface HardwareReport {
  platform: NodeJS.Platform;
  arch: string;
  totalRamGB: number;
  cpuModel: string;
  gpu?: string;
  appleSilicon: boolean;
  recommendedTier: OllamaTier;
  recommendedModels: RecommendedModel[];
}

export interface RecommendedModel {
  tag: string;
  displayName: string;
  sizeGB: number;
  license: string;
  company: string;
  country: string;
  releasedAt?: string;
  note?: string;
  /// Set on entries whose underlying model family is trained for Ollama's
  /// tool-calling protocol. `recommendationsForTier` promotes these and
  /// the LocalPane shows a "Tools" badge next to them.
  supportsTools?: boolean;
}

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

function ollamaBinaryCandidates(): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.platform === 'win32') {
    const localAppdata = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    list.push(
      path.join(localAppdata, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(programFiles, 'Ollama', 'ollama.exe'),
    );
  } else {
    list.push(
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      path.join(home, '.ollama', 'bin', 'ollama'),
      '/Applications/Ollama.app/Contents/Resources/ollama',
    );
  }
  // Walk PATH too, since anyone can have put the binary anywhere.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  for (const dir of pathDirs) list.push(path.join(dir, exe));
  return Array.from(new Set(list));
}

function firstExistingBinary(): string | undefined {
  for (const p of ollamaBinaryCandidates()) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function httpGetJson<T>(pathname: string, timeoutMs = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: OLLAMA_HOST, port: OLLAMA_PORT, path: pathname, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
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

async function detectRunningServer(): Promise<{ running: boolean; models: OllamaModel[]; version?: string }> {
  const tags = await httpGetJson<{ models?: Array<{ name: string; size: number; modified_at?: string }> }>(
    '/api/tags',
  );
  if (!tags) return { running: false, models: [] };
  const versionResp = await httpGetJson<{ version?: string }>('/api/version');
  const models: OllamaModel[] = (tags.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    modifiedAt: m.modified_at,
  }));
  return { running: true, models, version: versionResp?.version };
}

function brewAvailable(): boolean {
  // Electron on macOS inherits a minimal PATH from Finder that often
  // excludes /opt/homebrew/bin and /usr/local/bin, so a bare `brew`
  // lookup misses real installs. Check common locations explicitly.
  const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return true;
    } catch {}
  }
  const res = spawnSync('brew', ['--version'], { encoding: 'utf-8', timeout: 2000 });
  return !res.error && res.status === 0;
}

export async function detectOllama(): Promise<OllamaDetection> {
  const bin = firstExistingBinary();
  const server = await detectRunningServer();
  const installed = !!bin || server.running;
  if (!installed) {
    return {
      installed: false,
      running: false,
      models: [],
      installHint: {
        brewAvailable: process.platform === 'darwin' && brewAvailable(),
        downloadUrl: OLLAMA_DOWNLOAD_URL,
      },
    };
  }
  return {
    installed: true,
    running: server.running,
    version: server.version,
    binaryPath: bin,
    models: server.models,
  };
}

/// Inspects CPU / RAM / GPU to suggest a quant/size tier. The tier is a
/// conservative guess — users with real constraints (shared machine,
/// always-on workloads) will want something smaller.
export function detectHardware(): HardwareReport {
  const totalRamGB = Math.round(os.totalmem() / (1024 ** 3));
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const arch = process.arch;
  const appleSilicon = process.platform === 'darwin' && arch === 'arm64';
  const gpu = detectGpu();

  let tier: OllamaTier = 'tiny';
  if (totalRamGB >= 64 && appleSilicon) tier = 'large';
  else if (totalRamGB >= 32) tier = 'medium';
  else if (totalRamGB >= 16) tier = 'small';

  const recommendedModels = recommendationsForTier(tier);
  return {
    platform: process.platform,
    arch,
    totalRamGB,
    cpuModel,
    gpu,
    appleSilicon,
    recommendedTier: tier,
    recommendedModels,
  };
}

function detectGpu(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const res = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
    encoding: 'utf-8',
    timeout: 4000,
  });
  if (res.error || res.status !== 0) return undefined;
  try {
    const data = JSON.parse(res.stdout);
    const displays = data?.SPDisplaysDataType;
    if (Array.isArray(displays) && displays[0]?._name) return displays[0]._name as string;
  } catch {
    // ignore
  }
  return undefined;
}

/// Curated catalog of coder-relevant Ollama tags with maker + country +
/// license metadata. Ollama itself has no API to list the library and
/// carries no origin info on model cards, so this list is hand-
/// maintained. Licenses and sizes reflect the model card as of 2026-04;
/// verify before shipping copy changes. Tags not in this catalog still
/// work end-to-end — users can `ollama pull` anything — they just won't
/// appear in the in-app browser.
export const OLLAMA_CATALOG: RecommendedModel[] = [
  // --- Alibaba Cloud (China) ---
  {
    tag: 'qwen2.5-coder:3b',
    displayName: 'Qwen2.5-Coder 3B',
    sizeGB: 1.9,
    license: 'Qwen Research',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2024-11',
    note: 'Non-commercial license — check terms before commercial use.',
    supportsTools: true,
  },
  { tag: 'qwen2.5-coder:7b', displayName: 'Qwen2.5-Coder 7B', sizeGB: 4.7, license: 'Apache 2.0', company: 'Alibaba Cloud', country: 'CN', releasedAt: '2024-11', supportsTools: true },
  { tag: 'qwen2.5-coder:14b', displayName: 'Qwen2.5-Coder 14B', sizeGB: 9.0, license: 'Apache 2.0', company: 'Alibaba Cloud', country: 'CN', releasedAt: '2024-11', supportsTools: true },
  { tag: 'qwen2.5-coder:32b', displayName: 'Qwen2.5-Coder 32B', sizeGB: 20.0, license: 'Apache 2.0', company: 'Alibaba Cloud', country: 'CN', releasedAt: '2024-11', supportsTools: true },
  { tag: 'qwen2.5:7b', displayName: 'Qwen2.5 7B', sizeGB: 4.7, license: 'Apache 2.0', company: 'Alibaba Cloud', country: 'CN', releasedAt: '2024-09', supportsTools: true },
  { tag: 'qwen2.5:14b', displayName: 'Qwen2.5 14B', sizeGB: 9.0, license: 'Apache 2.0', company: 'Alibaba Cloud', country: 'CN', releasedAt: '2024-09', supportsTools: true },

  // --- DeepSeek (China) ---
  {
    tag: 'deepseek-coder-v2:16b',
    displayName: 'DeepSeek-Coder-V2 16B',
    sizeGB: 8.9,
    license: 'DeepSeek License',
    company: 'DeepSeek',
    country: 'CN',
    releasedAt: '2024-07',
    note: 'Permits commercial use; review license terms.',
  },
  { tag: 'deepseek-r1:7b', displayName: 'DeepSeek-R1 7B', sizeGB: 4.7, license: 'MIT', company: 'DeepSeek', country: 'CN', releasedAt: '2025-01' },
  { tag: 'deepseek-r1:14b', displayName: 'DeepSeek-R1 14B', sizeGB: 9.0, license: 'MIT', company: 'DeepSeek', country: 'CN', releasedAt: '2025-01' },
  { tag: 'deepseek-r1:32b', displayName: 'DeepSeek-R1 32B', sizeGB: 20.0, license: 'MIT', company: 'DeepSeek', country: 'CN', releasedAt: '2025-01' },

  // --- Meta (US) ---
  { tag: 'llama4:scout', displayName: 'Llama 4 Scout', sizeGB: 65.0, license: 'Llama 4 License', company: 'Meta', country: 'US', releasedAt: '2025-04', note: 'Mixture-of-experts: 17B active × 16 experts (~109B total).', supportsTools: true },
  { tag: 'llama3.3:70b', displayName: 'Llama 3.3 70B', sizeGB: 43.0, license: 'Llama 3.3 License', company: 'Meta', country: 'US', releasedAt: '2024-12', supportsTools: true },
  { tag: 'llama3.2:3b', displayName: 'Llama 3.2 3B', sizeGB: 2.0, license: 'Llama 3.2 License', company: 'Meta', country: 'US', releasedAt: '2024-09', supportsTools: true },
  { tag: 'llama3.1:8b', displayName: 'Llama 3.1 8B', sizeGB: 4.7, license: 'Llama 3.1 License', company: 'Meta', country: 'US', releasedAt: '2024-07', supportsTools: true },
  { tag: 'codellama:7b', displayName: 'Code Llama 7B', sizeGB: 3.8, license: 'Llama 2 License', company: 'Meta', country: 'US', releasedAt: '2023-08' },
  { tag: 'codellama:13b', displayName: 'Code Llama 13B', sizeGB: 7.4, license: 'Llama 2 License', company: 'Meta', country: 'US', releasedAt: '2023-08' },
  { tag: 'codellama:34b', displayName: 'Code Llama 34B', sizeGB: 19.0, license: 'Llama 2 License', company: 'Meta', country: 'US', releasedAt: '2023-08' },

  // --- Microsoft (US) ---
  { tag: 'phi4:14b', displayName: 'Phi 4 14B', sizeGB: 9.1, license: 'MIT', company: 'Microsoft', country: 'US', releasedAt: '2025-01' },
  { tag: 'phi4-mini:3.8b', displayName: 'Phi 4 Mini 3.8B', sizeGB: 2.5, license: 'MIT', company: 'Microsoft', country: 'US', releasedAt: '2025-02' },
  { tag: 'phi3.5:3.8b', displayName: 'Phi 3.5 3.8B', sizeGB: 2.2, license: 'MIT', company: 'Microsoft', country: 'US', releasedAt: '2024-08' },

  // --- Google (US) ---
  { tag: 'gemma4:31b', displayName: 'Gemma 4 31B', sizeGB: 20.0, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2026-04' },
  { tag: 'gemma4:26b', displayName: 'Gemma 4 26B', sizeGB: 18.0, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2026-04', note: 'Mixture-of-experts: 3.8B active params out of ~25B total.' },
  { tag: 'gemma4:e4b', displayName: 'Gemma 4 E4B', sizeGB: 9.6, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2026-04', note: 'Edge-optimized variant — 4.5B effective params.' },
  { tag: 'gemma4:e2b', displayName: 'Gemma 4 E2B', sizeGB: 7.2, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2026-04', note: 'Edge-optimized variant — 2.3B effective params.' },
  { tag: 'gemma3:27b', displayName: 'Gemma 3 27B', sizeGB: 17.0, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2025-03' },
  { tag: 'gemma3:12b', displayName: 'Gemma 3 12B', sizeGB: 8.1, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2025-03' },
  { tag: 'gemma3:4b', displayName: 'Gemma 3 4B', sizeGB: 3.3, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2025-03' },
  { tag: 'gemma2:9b', displayName: 'Gemma 2 9B', sizeGB: 5.4, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2024-06' },
  { tag: 'codegemma:7b', displayName: 'CodeGemma 7B', sizeGB: 5.0, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2024-04' },
  { tag: 'codegemma:2b', displayName: 'CodeGemma 2B', sizeGB: 1.6, license: 'Gemma License', company: 'Google', country: 'US', releasedAt: '2024-04' },

  // --- IBM (US) ---
  { tag: 'granite-code:8b', displayName: 'Granite Code 8B', sizeGB: 4.6, license: 'Apache 2.0', company: 'IBM', country: 'US', releasedAt: '2024-05' },
  { tag: 'granite-code:20b', displayName: 'Granite Code 20B', sizeGB: 12.0, license: 'Apache 2.0', company: 'IBM', country: 'US', releasedAt: '2024-05' },

  // --- Mistral AI (France) ---
  { tag: 'mistral:7b', displayName: 'Mistral 7B', sizeGB: 4.1, license: 'Apache 2.0', company: 'Mistral AI', country: 'FR', releasedAt: '2023-09', supportsTools: true },
  { tag: 'mixtral:8x7b', displayName: 'Mixtral 8x7B', sizeGB: 26.0, license: 'Apache 2.0', company: 'Mistral AI', country: 'FR', releasedAt: '2023-12', supportsTools: true },
  {
    tag: 'codestral:22b',
    displayName: 'Codestral 22B',
    sizeGB: 13.0,
    license: 'Mistral AI Non-Production License',
    company: 'Mistral AI',
    country: 'FR',
    releasedAt: '2024-05',
    note: 'Non-commercial license — check terms before commercial use.',
    supportsTools: true,
  },

  // --- BigCode consortium (EU-led, multi-national) ---
  { tag: 'starcoder2:7b', displayName: 'StarCoder2 7B', sizeGB: 4.0, license: 'BigCode OpenRAIL-M', company: 'BigCode', country: 'EU', releasedAt: '2024-02' },
  { tag: 'starcoder2:15b', displayName: 'StarCoder2 15B', sizeGB: 9.0, license: 'BigCode OpenRAIL-M', company: 'BigCode', country: 'EU', releasedAt: '2024-02' },
];

/// Approximate RAM headroom required to run a model comfortably. Ollama
/// itself will happily pull a model that's too big and then thrash, so
/// we filter the catalog against available RAM in `recommendationsForTier`.
function ramCeilingForTier(tier: OllamaTier): number {
  switch (tier) {
    case 'tiny':
      return 4;
    case 'small':
      return 8;
    case 'medium':
      return 14;
    case 'large':
      return 32;
  }
}

function recommendationsForTier(tier: OllamaTier): RecommendedModel[] {
  const cap = ramCeilingForTier(tier);
  // Top N that fit the user's RAM. Tool-capable models come first so an
  // agentic workflow (read files, grep, etc.) works out of the box; within
  // each tool/no-tool group we rank by release recency, then coder focus,
  // then size. Frontier models from the last ~12 months usually beat older
  // coder-specific fine-tunes on both general and coding benchmarks.
  const fit = OLLAMA_CATALOG.filter((m) => m.sizeGB <= cap);
  const ranked = fit.slice().sort((a, b) => {
    const aTools = a.supportsTools ? 0 : 1;
    const bTools = b.supportsTools ? 0 : 1;
    if (aTools !== bTools) return aTools - bTools;
    const aDate = a.releasedAt ?? '0000-00';
    const bDate = b.releasedAt ?? '0000-00';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    const aCoder = /coder|code/i.test(a.tag) ? 0 : 1;
    const bCoder = /coder|code/i.test(b.tag) ? 0 : 1;
    if (aCoder !== bCoder) return aCoder - bCoder;
    return b.sizeGB - a.sizeGB;
  });
  return ranked.slice(0, 6);
}

/// Kicks off an Ollama install. On macOS with Homebrew we open Terminal.app
/// running `brew install ollama` so the user sees progress and can spot
/// failures — silent background installs leave people wondering if
/// anything is happening. Everywhere else we open the download page.
export async function installOllama(opener: (url: string) => void): Promise<{ started: 'brew' | 'browser'; detail?: string }> {
  if (process.platform === 'darwin' && brewAvailable()) {
    runInTerminal('brew install ollama');
    return { started: 'brew', detail: 'Opened Terminal running `brew install ollama`' };
  }
  opener(OLLAMA_DOWNLOAD_URL);
  return { started: 'browser', detail: OLLAMA_DOWNLOAD_URL };
}

export interface ServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

/// Manages an `ollama serve` child process with its stdout/stderr piped
/// back to the main process so the UI can show live logs. One instance,
/// created at app start. The server lives as long as overcli does —
/// killed on app quit. If the user already has Ollama running (e.g. via
/// Ollama.app or brew services), start() is a no-op once detection sees
/// port 11434 bound, and we show a system log line explaining that.
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

export class OllamaServerManager {
  private child: ServerChild | null = null;
  private status: ServerStatus = 'stopped';
  private log: ServerLogLine[] = [];
  private readonly maxLog = 500;
  private listeners = new Set<(line: ServerLogLine) => void>();
  private statusListeners = new Set<(status: ServerStatus) => void>();

  getStatus(): ServerStatus {
    return this.status;
  }

  getLog(): ServerLogLine[] {
    return this.log.slice();
  }

  onLog(fn: (line: ServerLogLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatusChange(fn: (status: ServerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    // Already running in-proc.
    if (this.child && !this.child.killed) {
      return { ok: true, message: 'Server already running under overcli.' };
    }
    // Someone else (Ollama.app, brew services) is bound to :11434. Don't
    // try to spawn a second one — port conflict, and the existing server
    // works fine for our HTTP calls.
    const external = await detectRunningServer();
    if (external.running) {
      this.setStatus('running');
      this.append({
        stream: 'system',
        text: 'Ollama server already running (external process on 127.0.0.1:11434). Skipping spawn.',
        timestamp: Date.now(),
      });
      return { ok: true, message: 'External Ollama server detected.' };
    }

    const bin = firstExistingBinary();
    if (!bin) {
      this.setStatus('error');
      this.append({
        stream: 'system',
        text: 'Ollama binary not found. Install it via the Local tab first.',
        timestamp: Date.now(),
      });
      return { ok: false, message: 'Ollama binary not found.' };
    }

    this.setStatus('starting');
    this.append({ stream: 'system', text: `Spawning ${bin} serve`, timestamp: Date.now() });

    let child: ServerChild;
    try {
      child = spawn(bin, ['serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ServerChild;
    } catch (err: any) {
      this.setStatus('error');
      this.append({
        stream: 'system',
        text: `Failed to spawn: ${err?.message ?? String(err)}`,
        timestamp: Date.now(),
      });
      return { ok: false, message: err?.message ?? String(err) };
    }

    this.child = child;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.ingest('stdout', chunk));
    child.stderr.on('data', (chunk: string) => this.ingest('stderr', chunk));
    child.on('error', (err) => {
      this.append({ stream: 'system', text: `Error: ${err.message}`, timestamp: Date.now() });
      this.setStatus('error');
    });
    child.on('close', (code) => {
      this.append({
        stream: 'system',
        text: `Server exited with code ${code}`,
        timestamp: Date.now(),
      });
      this.child = null;
      this.setStatus('stopped');
    });

    // Poll the HTTP port briefly — ollama takes ~1-2s to bind. When the
    // probe succeeds we flip to `running`; if it never binds we stay in
    // `starting` (the child's stderr will usually explain why).
    void this.waitForPort(10_000);

    return { ok: true, message: 'Server starting.' };
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill('SIGTERM');
    } catch {}
  }

  private async waitForPort(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child == null) return; // died mid-wait
      const probe = await detectRunningServer();
      if (probe.running) {
        this.setStatus('running');
        this.append({
          stream: 'system',
          text: `Server is up on 127.0.0.1:${OLLAMA_PORT}.`,
          timestamp: Date.now(),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private ingest(stream: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.append({ stream, text: trimmed, timestamp: Date.now() });
    }
  }

  private append(line: ServerLogLine): void {
    this.log.push(line);
    if (this.log.length > this.maxLog) {
      this.log.splice(0, this.log.length - this.maxLog);
    }
    for (const l of this.listeners) l(line);
  }

  private setStatus(next: ServerStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.statusListeners) l(next);
  }
}

/// Singleton — main/index.ts owns the lifecycle.
export const ollamaServer = new OllamaServerManager();

export type PullProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; percent: number; completed: number; total: number; message?: string }
  | { type: 'done'; success: boolean; message?: string };

/// POST /api/pull with stream=true. Emits progress events via the supplied
/// callback. Returns when the server signals completion (or errors).
export function pullModel(
  tag: string,
  onEvent: (ev: PullProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: tag, stream: true });
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/pull',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, 400);
            onEvent({ type: 'done', success: false, message: text });
            resolve({ ok: false, error: text || `status ${res.statusCode}` });
          });
          return;
        }
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (typeof evt.total === 'number' && typeof evt.completed === 'number' && evt.total > 0) {
                onEvent({
                  type: 'progress',
                  percent: Math.min(100, Math.round((evt.completed / evt.total) * 100)),
                  completed: evt.completed,
                  total: evt.total,
                  message: evt.status,
                });
              } else if (evt.status) {
                onEvent({ type: 'status', message: String(evt.status) });
              }
            } catch {
              // ignore malformed lines
            }
          }
        });
        res.on('end', () => {
          onEvent({ type: 'done', success: true });
          resolve({ ok: true });
        });
        res.on('error', (err) => {
          onEvent({ type: 'done', success: false, message: err.message });
          resolve({ ok: false, error: err.message });
        });
      },
    );
    req.on('error', (err) => {
      onEvent({ type: 'done', success: false, message: err.message });
      resolve({ ok: false, error: err.message });
    });
    signal?.addEventListener('abort', () => {
      try {
        req.destroy(new Error('aborted'));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}

/// DELETE /api/delete. Removes a pulled model from the local Ollama store.
export function deleteModel(
  tag: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: tag });
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/delete',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, 400);
            resolve({ ok: false, error: text || `status ${res.statusCode}` });
            return;
          }
          resolve({ ok: true });
        });
        res.on('error', (err) => resolve({ ok: false, error: err.message }));
      },
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

export interface OllamaToolCall {
  /// Ollama does not always emit an id for tool calls; we synthesize one
  /// when absent so the runner can correlate the call with its result.
  id: string;
  name: string;
  /// Arguments as returned by the model. Already an object — Ollama parses
  /// the model's JSON before streaming it back. We keep it unknown because
  /// each tool validates its own schema.
  arguments: Record<string, unknown>;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /// Populated on assistant messages that issued tool calls, so the next
  /// turn's transcript preserves the call/result pairing Ollama expects.
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  /// Required on `role: "tool"` replies — the name of the tool whose
  /// output this message carries.
  tool_name?: string;
}

/// Tool schema in the shape Ollama's /api/chat accepts (a subset of the
/// OpenAI function-calling schema). Kept loose — the runner defines the
/// concrete tools and we just forward them on the wire.
export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'toolCalls'; calls: OllamaToolCall[] }
  | { type: 'done'; totalDurationMs?: number; evalCount?: number; promptEvalCount?: number }
  | { type: 'error'; message: string };

/// POST /api/chat with stream=true. Emits tokens as they arrive, a
/// `toolCalls` event if the model issued one or more tool calls, then a
/// terminal `done` event. Abort via the signal to stop mid-response.
///
/// When `tools` is set, Ollama switches into tool-calling mode for models
/// trained on it (qwen2.5, llama3.1+, mistral, codestral, llama4). Models
/// without tool support ignore the field and reply in plain text.
export function streamChat(
  args: {
    model: string;
    messages: OllamaChatMessage[];
    tools?: OllamaToolDefinition[];
    signal?: AbortSignal;
  },
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const payload: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      stream: true,
    };
    if (args.tools && args.tools.length > 0) payload.tools = args.tools;
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, 400);
            onEvent({ type: 'error', message: text || `status ${res.statusCode}` });
            resolve();
          });
          return;
        }
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (evt.message?.content) {
                onEvent({ type: 'token', text: String(evt.message.content) });
              }
              const rawCalls = evt.message?.tool_calls;
              if (Array.isArray(rawCalls) && rawCalls.length > 0) {
                const calls: OllamaToolCall[] = rawCalls
                  .map((c: any, i: number) => {
                    const name = c?.function?.name;
                    if (typeof name !== 'string' || !name) return null;
                    const rawArgs = c?.function?.arguments;
                    let parsedArgs: Record<string, unknown> = {};
                    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
                      parsedArgs = rawArgs as Record<string, unknown>;
                    } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
                      try {
                        const p = JSON.parse(rawArgs);
                        if (p && typeof p === 'object' && !Array.isArray(p)) parsedArgs = p;
                      } catch {
                        // leave args empty; tool executor will surface the schema error
                      }
                    }
                    return {
                      id: typeof c?.id === 'string' && c.id ? c.id : `call_${Date.now()}_${i}`,
                      name,
                      arguments: parsedArgs,
                    } satisfies OllamaToolCall;
                  })
                  .filter((c): c is OllamaToolCall => c !== null);
                if (calls.length > 0) onEvent({ type: 'toolCalls', calls });
              }
              if (evt.done) {
                onEvent({
                  type: 'done',
                  totalDurationMs:
                    typeof evt.total_duration === 'number'
                      ? Math.round(evt.total_duration / 1e6)
                      : undefined,
                  evalCount: evt.eval_count,
                  promptEvalCount: evt.prompt_eval_count,
                });
              }
            } catch {
              // ignore malformed lines
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', (err) => {
          onEvent({ type: 'error', message: err.message });
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      onEvent({ type: 'error', message: err.message });
      resolve();
    });
    args.signal?.addEventListener('abort', () => {
      try {
        req.destroy(new Error('aborted'));
      } catch {}
    });
    req.write(body);
    req.end();
  });
}
