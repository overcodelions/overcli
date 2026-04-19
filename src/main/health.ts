// Backend auth/ready probes. Matches the Swift app's health badges — each
// backend gets a quick sync check to see whether the CLI is installed AND
// authenticated.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backend, BackendHealth } from '../shared/types';
import { buildBackendEnv, resolveBackendPath } from './backendPaths';

export { resolveBackendPath };

/// Cheap sync check for Ollama — is the binary or its data dir present?
/// Actual server-running + model-list probing happens async via the
/// `ollama:detect` IPC handler (see main/ollama.ts).
function ollamaBinaryOrDataPresent(): boolean {
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ollama', 'ollama.exe'),
        ]
      : [
          '/usr/local/bin/ollama',
          '/opt/homebrew/bin/ollama',
          path.join(home, '.ollama'),
          '/Applications/Ollama.app',
        ];
  return candidates.some((p) => p && existsSync(p));
}

function hasAnyFile(paths: string[]): boolean {
  return paths.some((p) => existsSync(p));
}

function hasAnyEnv(names: string[]): boolean {
  return names.some((name) => !!process.env[name]);
}

export function probeBackendHealth(backend: Backend, override?: string): BackendHealth {
  if (backend === 'ollama') {
    if (ollamaBinaryOrDataPresent()) {
      return { kind: 'ready', message: 'Ollama found. Open Settings → Local models for details.' };
    }
    return { kind: 'missing', message: 'Ollama not installed. Open Settings → Local models to set it up.' };
  }
  const bin = resolveBackendPath(backend, override);
  if (!bin) return { kind: 'missing', message: `${backend} CLI not found on disk` };
  const env = buildBackendEnv(process.env, bin);

  // Fast check: does the binary execute and print a version? This also
  // verifies PATH/entitlement issues before we trust the CLI at all.
  const versionRes = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 4000, env });
  if (versionRes.error) {
    return { kind: 'error', message: versionRes.error.message };
  }
  if (versionRes.status !== 0) {
    return { kind: 'error', message: versionRes.stderr?.slice(0, 200) || `exit ${versionRes.status}` };
  }

  // Auth check varies by backend. Prefer a local CLI status command where
  // available; otherwise check the credential stores used by current and
  // older CLI releases. Keep this network-free.
  if (backend === 'claude') {
    if (hasAnyEnv(['ANTHROPIC_API_KEY'])) return { kind: 'ready' };

    const statusRes = spawnSync(bin, ['auth', 'status'], { encoding: 'utf-8', timeout: 4000, env });
    if (!statusRes.error && statusRes.status === 0) {
      return { kind: 'ready' };
    }

    const home = os.homedir();
    if (
      !hasAnyFile([
        path.join(home, '.claude.json'),
        path.join(home, '.claude', 'auth.json'),
        path.join(home, '.claude', 'config.json'),
      ])
    ) {
      return { kind: 'unauthenticated', message: 'Run `claude auth login` in a terminal.' };
    }
  } else if (backend === 'codex') {
    const authFile = path.join(os.homedir(), '.codex', 'auth.json');
    if (!existsSync(authFile) && !hasAnyEnv(['OPENAI_API_KEY'])) {
      return { kind: 'unauthenticated', message: 'Run `codex login` in a terminal.' };
    }
  } else if (backend === 'gemini') {
    const home = os.homedir();
    if (
      !hasAnyEnv(['GEMINI_API_KEY', 'GOOGLE_API_KEY']) &&
      !hasAnyFile([
        path.join(home, '.gemini', 'credentials.json'),
        path.join(home, '.gemini', 'oauth_creds.json'),
        path.join(home, '.gemini', 'google_accounts.json'),
      ])
    ) {
      return { kind: 'unauthenticated', message: 'Run `gemini auth login` in a terminal.' };
    }
  }

  return { kind: 'ready' };
}

/// Discovered reviewer backends — any that are `ready` AND installed.
export function listInstalledReviewers(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const backend of ['claude', 'codex', 'gemini', 'ollama'] as Backend[]) {
    const health = probeBackendHealth(backend);
    out[backend] = health.kind === 'ready';
  }
  return out;
}
