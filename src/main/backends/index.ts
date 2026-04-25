// Backend registry. All four backends are now wired through here;
// runner.ts dispatches `buildArgs` / `buildEnvelope` exclusively via the
// registry. Ollama's spec throws (it's HTTP-only and has its own send
// path); the other three implement the subprocess contract.

import type { Backend } from '../../shared/types';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { geminiBackend } from './gemini';
import { ollamaBackend } from './ollama';
import type { BackendSpec } from './types';

const SPECS: Record<Backend, BackendSpec> = {
  claude: claudeBackend,
  codex: codexBackend,
  gemini: geminiBackend,
  ollama: ollamaBackend,
};

/// Returns the spec for a backend. Always defined now that all four
/// backends are migrated.
export function getBackendSpec(name: Backend): BackendSpec {
  return SPECS[name];
}

export type { BackendCtx, BackendSendArgs, BackendSpec } from './types';
