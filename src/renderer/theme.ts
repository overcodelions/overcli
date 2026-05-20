// Per-backend theme helpers. Mirrors the Swift BackendTheme lookups so
// rows and headers tint consistently with the Mac build.

import { Backend } from '@shared/types';

export function backendColor(backend: Backend | null | undefined): string {
  switch (backend) {
    case 'codex':
      return '#5b9cff'; // blue
    case 'gemini':
      return '#3dced7'; // cyan/teal
    case 'ollama':
      return '#f29e4c'; // amber — "local"
    case 'copilot':
      // Magenta-pink pulled from Copilot's logo gradient. Avoid the
      // GitHub green (#7ee787) — that clashes with the sidebar's
      // active-conversation indicator dot.
      return '#f471b5';
    case 'claude':
    default:
      return '#b587ff'; // purple
  }
}

export function backendName(backend: Backend | null | undefined): string {
  switch (backend) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Ollama';
    case 'copilot':
      return 'Copilot';
    case 'claude':
    default:
      return 'Claude';
  }
}

export function backendIcon(backend: Backend | null | undefined): string {
  switch (backend) {
    case 'codex':
      return '⚙';
    case 'gemini':
      return '✦';
    case 'ollama':
      return '◉';
    case 'copilot':
      return '⌥';
    case 'claude':
    default:
      return '◈';
  }
}

export function backendFromModel(model: string | null | undefined): Backend {
  if (!model) return 'claude';
  const m = model.toLowerCase();
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('codex') || m.includes('gpt-')) return 'codex';
  if (m.includes('ollama')) return 'ollama';
  if (m.includes('copilot')) return 'copilot';
  if (m.includes('claude')) return 'claude';
  // Ollama tags are always `name:tag` (e.g. gemma4:26b, qwen2.5-coder:7b).
  // Cloud-backend models never use that shape, so a bare colon means local.
  if (/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/.test(m)) return 'ollama';
  return 'claude';
}

/// Collapsed model display for tight UI spots.
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  // claude-opus-4-7 → opus 4.7
  const m = model.replace(/^claude-/, '').replace(/-/g, ' ');
  return m;
}
