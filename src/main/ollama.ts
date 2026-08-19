// Ollama integration. overcli talks to a locally-installed Ollama server
// (http://127.0.0.1:11434) — we don't bundle or redistribute weights.
// Users pull models themselves via `ollama pull`, which means they accept
// each model's license (Apache 2.0, Gemma Terms of Use, the Llama community
// licenses, etc.) directly. Our job is to detect, surface, and make that
// setup easy.

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

export function brewAvailable(): boolean {
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

/// `system_profiler` costs 200-800ms and runs on the MAIN process, which
/// blocks every window — and `ollama:hardware` is polled every 4s by the
/// Local pane for as long as the server isn't running. The GPU can't change
/// while the app is open, so probe once per launch and reuse the answer.
let gpuCache: { value: string | undefined } | null = null;

function detectGpu(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  if (!gpuCache) gpuCache = { value: probeGpu() };
  return gpuCache.value;
}

function probeGpu(): string | undefined {
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
/// license metadata. Ollama has no API to list its library and carries no
/// origin info on model cards, so this list is hand-maintained — the cost of
/// that is it rots, and it had by roughly sixteen months before this refresh.
///
/// Last refreshed 2026-08-18 against ollama.com/library: every `tag` below was
/// confirmed to exist, and `sizeGB` and `license` were read off the registry's
/// own tag pages rather than recalled. `releasedAt` is the model's release
/// month and drives the recency sort in `recommendationsForTier`.
///
/// Only locally-runnable tags belong here. Several current families
/// (deepseek-v4, glm-5.x, kimi-k3, minimax-m3, mistral-large-3) publish
/// `-cloud` tags only and are deliberately absent: this pane is about models
/// that run on the user's own machine.
///
/// Tags not in this catalog still work end-to-end — users can `ollama pull`
/// anything — but note `modelSupportsTools()` answers from this list, so a
/// tool-capable model that is missing here gets no tools.
export const OLLAMA_CATALOG: RecommendedModel[] = [
  // --- Alibaba Cloud (China) ---
  {
    tag: 'qwen3.8:27b',
    displayName: 'Qwen3.8 27B',
    sizeGB: 17.7,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-08',
    supportsTools: true,
  },
  {
    tag: 'qwen3.6:27b',
    displayName: 'Qwen3.6 27B',
    sizeGB: 17.4,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-05',
    supportsTools: true,
  },
  {
    tag: 'qwen3.6:35b',
    displayName: 'Qwen3.6 35B',
    sizeGB: 23.9,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-04',
    note: 'Mixture-of-experts: 3B active params.',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:35b',
    displayName: 'Qwen3.5 35B',
    sizeGB: 23.9,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    note: 'Mixture-of-experts: 3B active params.',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:27b',
    displayName: 'Qwen3.5 27B',
    sizeGB: 17.4,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:9b',
    displayName: 'Qwen3.5 9B',
    sizeGB: 6.6,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:4b',
    displayName: 'Qwen3.5 4B',
    sizeGB: 3.4,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:2b',
    displayName: 'Qwen3.5 2B',
    sizeGB: 2.7,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    supportsTools: true,
  },
  {
    tag: 'qwen3.5:0.8b',
    displayName: 'Qwen3.5 0.8B',
    sizeGB: 1.0,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2026-03',
    supportsTools: true,
  },
  {
    tag: 'qwen3-coder:30b',
    displayName: 'Qwen3-Coder 30B',
    sizeGB: 18.6,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2025-10',
    supportsTools: true,
  },
  {
    tag: 'qwen2.5-coder:32b',
    displayName: 'Qwen2.5-Coder 32B',
    sizeGB: 19.9,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2024-11',
    supportsTools: true,
  },
  {
    tag: 'qwen2.5-coder:14b',
    displayName: 'Qwen2.5-Coder 14B',
    sizeGB: 9.0,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2024-11',
    supportsTools: true,
  },
  {
    tag: 'qwen2.5-coder:7b',
    displayName: 'Qwen2.5-Coder 7B',
    sizeGB: 4.7,
    license: 'Apache 2.0',
    company: 'Alibaba Cloud',
    country: 'CN',
    releasedAt: '2024-11',
    supportsTools: true,
  },

  // --- DeepSeek (China) ---
  {
    tag: 'deepseek-r1:32b',
    displayName: 'DeepSeek-R1 32B',
    sizeGB: 19.9,
    license: 'MIT',
    company: 'DeepSeek',
    country: 'CN',
    releasedAt: '2025-01',
    supportsTools: true,
  },
  {
    tag: 'deepseek-r1:14b',
    displayName: 'DeepSeek-R1 14B',
    sizeGB: 9.0,
    license: 'MIT',
    company: 'DeepSeek',
    country: 'CN',
    releasedAt: '2025-01',
    supportsTools: true,
  },
  {
    tag: 'deepseek-r1:7b',
    displayName: 'DeepSeek-R1 7B',
    sizeGB: 4.7,
    license: 'MIT',
    company: 'DeepSeek',
    country: 'CN',
    releasedAt: '2025-01',
    supportsTools: true,
  },

  // --- Z.ai / Zhipu (China) ---
  {
    tag: 'glm-4.7-flash:latest',
    displayName: 'GLM 4.7 Flash 30B',
    sizeGB: 19.0,
    license: 'MIT',
    company: 'Z.ai',
    country: 'CN',
    releasedAt: '2026-06',
    note: 'Published without a size-suffixed tag; :latest is the only local build.',
    supportsTools: true,
  },

  // --- Meta (US) ---
  {
    tag: 'llama4:scout',
    displayName: 'Llama 4 Scout',
    sizeGB: 67.4,
    license: 'Llama 4 License',
    company: 'Meta',
    country: 'US',
    releasedAt: '2025-04',
    note: 'Mixture-of-experts: 17B active x 16 experts (~109B total).',
    supportsTools: true,
  },
  {
    tag: 'llama3.3:70b',
    displayName: 'Llama 3.3 70B',
    sizeGB: 42.5,
    license: 'Llama 3.3 License',
    company: 'Meta',
    country: 'US',
    releasedAt: '2024-12',
    supportsTools: true,
  },
  {
    tag: 'llama3.2:3b',
    displayName: 'Llama 3.2 3B',
    sizeGB: 2.0,
    license: 'Llama 3.2 License',
    company: 'Meta',
    country: 'US',
    releasedAt: '2024-09',
    supportsTools: true,
  },
  {
    tag: 'llama3.1:8b',
    displayName: 'Llama 3.1 8B',
    sizeGB: 4.9,
    license: 'Llama 3.1 License',
    company: 'Meta',
    country: 'US',
    releasedAt: '2024-07',
    supportsTools: true,
  },

  // --- Google (US) ---
  // Gemma 4 moved to Apache 2.0; Gemma 3 and earlier remain under Google's
  // own Gemma Terms of Use. Both verified against the registry's license blob.
  {
    tag: 'gemma4:31b',
    displayName: 'Gemma 4 31B',
    sizeGB: 19.9,
    license: 'Apache 2.0',
    company: 'Google',
    country: 'US',
    releasedAt: '2026-04',
    supportsTools: true,
  },
  {
    tag: 'gemma4:26b',
    displayName: 'Gemma 4 26B',
    sizeGB: 18.0,
    license: 'Apache 2.0',
    company: 'Google',
    country: 'US',
    releasedAt: '2026-04',
    note: 'Mixture-of-experts: 3.8B active params out of ~25B total.',
    supportsTools: true,
  },
  {
    tag: 'gemma4:12b',
    displayName: 'Gemma 4 12B',
    sizeGB: 7.6,
    license: 'Apache 2.0',
    company: 'Google',
    country: 'US',
    releasedAt: '2026-06',
    supportsTools: true,
  },
  {
    tag: 'gemma4:e4b',
    displayName: 'Gemma 4 E4B',
    sizeGB: 9.6,
    license: 'Apache 2.0',
    company: 'Google',
    country: 'US',
    releasedAt: '2026-04',
    note: 'Edge-optimized variant — 4.5B effective params.',
    supportsTools: true,
  },
  {
    tag: 'gemma4:e2b',
    displayName: 'Gemma 4 E2B',
    sizeGB: 7.2,
    license: 'Apache 2.0',
    company: 'Google',
    country: 'US',
    releasedAt: '2026-04',
    note: 'Edge-optimized variant — 2.3B effective params.',
    supportsTools: true,
  },
  {
    tag: 'gemma3:27b',
    displayName: 'Gemma 3 27B',
    sizeGB: 17.4,
    license: 'Gemma Terms of Use',
    company: 'Google',
    country: 'US',
    releasedAt: '2025-03',
  },
  {
    tag: 'gemma3:12b',
    displayName: 'Gemma 3 12B',
    sizeGB: 8.2,
    license: 'Gemma Terms of Use',
    company: 'Google',
    country: 'US',
    releasedAt: '2025-03',
  },
  {
    tag: 'gemma3:4b',
    displayName: 'Gemma 3 4B',
    sizeGB: 3.3,
    license: 'Gemma Terms of Use',
    company: 'Google',
    country: 'US',
    releasedAt: '2025-03',
  },
  {
    tag: 'gemma3:1b',
    displayName: 'Gemma 3 1B',
    sizeGB: 0.8,
    license: 'Gemma Terms of Use',
    company: 'Google',
    country: 'US',
    releasedAt: '2025-03',
  },

  // --- OpenAI (US) ---
  {
    tag: 'gpt-oss:120b',
    displayName: 'gpt-oss 120B',
    sizeGB: 65.4,
    license: 'Apache 2.0',
    company: 'OpenAI',
    country: 'US',
    releasedAt: '2025-08',
    supportsTools: true,
  },
  {
    tag: 'gpt-oss:20b',
    displayName: 'gpt-oss 20B',
    sizeGB: 13.8,
    license: 'Apache 2.0',
    company: 'OpenAI',
    country: 'US',
    releasedAt: '2025-08',
    supportsTools: true,
  },

  // --- Microsoft (US) ---
  {
    tag: 'phi4:14b',
    displayName: 'Phi 4 14B',
    sizeGB: 9.1,
    license: 'MIT',
    company: 'Microsoft',
    country: 'US',
    releasedAt: '2025-01',
  },
  {
    tag: 'phi4-mini:3.8b',
    displayName: 'Phi 4 Mini 3.8B',
    sizeGB: 2.5,
    license: 'MIT',
    company: 'Microsoft',
    country: 'US',
    releasedAt: '2025-02',
    supportsTools: true,
  },

  // --- IBM (US) ---
  {
    tag: 'granite4.1:30b',
    displayName: 'Granite 4.1 30B',
    sizeGB: 17.5,
    license: 'Apache 2.0',
    company: 'IBM',
    country: 'US',
    releasedAt: '2026-05',
    supportsTools: true,
  },
  {
    tag: 'granite4.1:8b',
    displayName: 'Granite 4.1 8B',
    sizeGB: 5.4,
    license: 'Apache 2.0',
    company: 'IBM',
    country: 'US',
    releasedAt: '2026-05',
    supportsTools: true,
  },
  {
    tag: 'granite4.1:3b',
    displayName: 'Granite 4.1 3B',
    sizeGB: 2.1,
    license: 'Apache 2.0',
    company: 'IBM',
    country: 'US',
    releasedAt: '2026-05',
    supportsTools: true,
  },

  // --- NVIDIA (US) ---
  {
    tag: 'nemotron-3-nano:4b',
    displayName: 'Nemotron 3 Nano 4B',
    sizeGB: 2.8,
    license: 'NVIDIA Open Model License',
    company: 'NVIDIA',
    country: 'US',
    releasedAt: '2026-03',
    supportsTools: true,
  },

  // --- Allen Institute for AI (US) ---
  {
    tag: 'olmo-3.1:32b',
    displayName: 'OLMo 3.1 32B',
    sizeGB: 19.5,
    license: 'Apache 2.0',
    company: 'Ai2',
    country: 'US',
    releasedAt: '2025-12',
    note: 'Fully open: weights, data and training code all published.',
    supportsTools: true,
  },

  // --- Liquid AI (US) ---
  {
    tag: 'lfm2.5:8b',
    displayName: 'LFM2.5 8B',
    sizeGB: 5.2,
    license: 'LFM Open License v1.0',
    company: 'Liquid AI',
    country: 'US',
    releasedAt: '2026-06',
    supportsTools: true,
  },

  // --- Mistral AI (France) ---
  {
    tag: 'mistral-small3.2:24b',
    displayName: 'Mistral Small 3.2 24B',
    sizeGB: 15.2,
    license: 'Apache 2.0',
    company: 'Mistral AI',
    country: 'FR',
    releasedAt: '2025-06',
    supportsTools: true,
  },
  {
    tag: 'magistral:24b',
    displayName: 'Magistral 24B',
    sizeGB: 14.3,
    license: 'Apache 2.0',
    company: 'Mistral AI',
    country: 'FR',
    releasedAt: '2025-06',
    supportsTools: true,
  },
  {
    tag: 'ministral-3:14b',
    displayName: 'Ministral 3 14B',
    sizeGB: 9.1,
    license: 'Apache 2.0',
    company: 'Mistral AI',
    country: 'FR',
    releasedAt: '2025-12',
    supportsTools: true,
  },
  {
    tag: 'ministral-3:3b',
    displayName: 'Ministral 3 3B',
    sizeGB: 3.0,
    license: 'Apache 2.0',
    company: 'Mistral AI',
    country: 'FR',
    releasedAt: '2025-12',
    supportsTools: true,
  },

  // --- Hugging Face (France) ---
  {
    tag: 'smollm2:1.7b',
    displayName: 'SmolLM2 1.7B',
    sizeGB: 1.8,
    license: 'Apache 2.0',
    company: 'Hugging Face',
    country: 'FR',
    releasedAt: '2024-11',
    supportsTools: true,
  },
  {
    tag: 'smollm2:360m',
    displayName: 'SmolLM2 360M',
    sizeGB: 0.73,
    license: 'Apache 2.0',
    company: 'Hugging Face',
    country: 'FR',
    releasedAt: '2024-11',
    supportsTools: true,
  },
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
export async function installOllama(
  opener: (url: string) => void,
): Promise<{ started: 'brew' | 'browser'; detail?: string; command?: string }> {
  if (process.platform === 'darwin' && brewAvailable()) {
    const command = 'brew install ollama';
    const res = await runInTerminal(command, 'ollama-install');
    if (res.ok) return { started: 'brew', detail: `Opened Terminal running \`${command}\`` };
    // Terminal wouldn't take the command (usually a blocked Apple Event).
    // Fall back to the download page rather than reporting a phantom window.
    opener(OLLAMA_DOWNLOAD_URL);
    return { started: 'browser', detail: res.error, command: res.command ?? command };
  }
  opener(OLLAMA_DOWNLOAD_URL);
  return { started: 'browser', detail: OLLAMA_DOWNLOAD_URL };
}

/// True only when Homebrew is the package manager that owns the installed
/// Ollama. `brewAvailable()` alone isn't enough: plenty of people have brew
/// AND a .dmg-installed Ollama, and `brew upgrade ollama` fails for them.
export function brewManagesOllama(): boolean {
  if (process.platform !== 'darwin' || !brewAvailable()) return false;
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  const res = spawnSync(brew ?? 'brew', ['list', '--versions', 'ollama'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return !res.error && res.status === 0;
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

  /// True when the running server is the child overcli spawned — the only
  /// case where its environment is ours and restarting it is safe.
  isManaged(): boolean {
    return this.child != null && !this.child.killed;
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
        // Force loopback bind and a loopback-only origin allowlist, overriding
        // any inherited OLLAMA_HOST=0.0.0.0 / OLLAMA_ORIGINS=* so the server we
        // spawn is neither reachable from the LAN nor callable by a web page.
        env: {
          ...process.env,
          OLLAMA_HOST: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
          OLLAMA_ORIGINS: `http://${OLLAMA_HOST}:${OLLAMA_PORT},http://localhost:${OLLAMA_PORT}`,
        },
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
  /// Reasoning delta. Thinking-capable models (gemma4, deepseek-r1,
  /// qwen3, gpt-oss) return their chain of thought on `message.thinking`,
  /// a channel entirely separate from `message.content`. On a long prompt
  /// the content channel stays EMPTY for minutes while thinking streams —
  /// so a consumer that only watches `token` shows a frozen, blank bubble
  /// while the server is visibly working. Always surface this.
  | { type: 'thinking'; text: string }
  | { type: 'toolCalls'; calls: OllamaToolCall[] }
  | { type: 'done'; totalDurationMs?: number; evalCount?: number; promptEvalCount?: number }
  | { type: 'error'; message: string };

/// Generation bounds sent on every /api/chat call.
///
/// We previously sent no `options` at all, which meant unbounded
/// generation: a model that fell into a repetition loop — emitting the
/// same `read_file` / `edit_file` pair over and over, inventing the tool
/// results it never received — would generate until its context filled,
/// burning minutes of local compute and producing a wall of fabricated
/// tool-call JSON. The round-level stuck-loop guard could not help,
/// because it only compares text BETWEEN rounds and this never finished a
/// round.
///
/// `num_predict` is the backstop for that: a hard ceiling on tokens per
/// round. 4096 is comfortably more than any single tool call or final
/// answer needs, while capping a runaway at seconds rather than minutes.
/// `repeat_penalty` discourages the degenerate loop from starting.
const DEFAULT_CHAT_OPTIONS: Record<string, unknown> = {
  num_predict: 4096,
  repeat_penalty: 1.1,
};

/// How long Ollama keeps the model resident after a request. The default
/// is 5 minutes, which a flow routinely exceeds: a plan step running on
/// Claude for several minutes lets the local model fall out of VRAM, so
/// the next Ollama step pays a full reload — for gemma4:26b that is 17.6
/// GB off disk before the first token. Holding it for the length of a
/// realistic step gap trades idle VRAM for removing that stall.
const DEFAULT_KEEP_ALIVE = '30m';

/// Cache of `/api/show` capability lookups, keyed by model tag. Capabilities
/// are a static property of the pulled model, so one probe per tag per
/// process run is enough.
const capabilityCache = new Map<string, Set<string>>();

/// Capabilities the pulled model declares — typically some of
/// `completion`, `tools`, `thinking`, `vision`, `insert`.
///
/// This is the authority on whether we can hand Ollama a `tools` array and
/// let its chat template drive tool calling. The static `OLLAMA_CATALOG`
/// flag can't answer it: it only covers tags we ship, and it describes the
/// model family rather than the specific build the user pulled.
///
/// Returns an empty set when Ollama is unreachable or the model is unknown,
/// so callers fall back to the in-prompt protocol rather than failing.
export async function modelCapabilities(tag: string): Promise<Set<string>> {
  const cached = capabilityCache.get(tag);
  if (cached) return cached;
  const res = await httpPostJson<{ capabilities?: unknown }>('/api/show', { model: tag });
  const caps = new Set<string>(
    Array.isArray(res?.capabilities) ? res!.capabilities.filter((c): c is string => typeof c === 'string') : [],
  );
  // Only cache a real answer — a failed probe shouldn't pin the model as
  // capability-less for the rest of the session.
  if (caps.size > 0) capabilityCache.set(tag, caps);
  return caps;
}

function httpPostJson<T>(pathname: string, body: unknown, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
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
    req.write(payload);
    req.end();
  });
}

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
    /// Generation bounds. Defaults applied when omitted — see
    /// `DEFAULT_CHAT_OPTIONS`.
    options?: Record<string, unknown>;
    /// Ollama residency hint, e.g. "30m". Defaults to `DEFAULT_KEEP_ALIVE`.
    keepAlive?: string;
  },
  onEvent: (ev: ChatStreamEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    // An already-aborted signal fires no 'abort' event, so the listener
    // installed at the bottom would never run and the request would go out
    // anyway. Bail before opening the socket.
    if (args.signal?.aborted) {
      onEvent({ type: 'error', message: 'aborted' });
      resolve();
      return;
    }
    const payload: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      stream: true,
      keep_alive: args.keepAlive ?? DEFAULT_KEEP_ALIVE,
      options: { ...DEFAULT_CHAT_OPTIONS, ...(args.options ?? {}) },
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
              if (evt.message?.thinking) {
                onEvent({ type: 'thinking', text: String(evt.message.thinking) });
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
