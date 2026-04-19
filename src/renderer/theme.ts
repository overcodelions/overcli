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
  if (m.includes('claude')) return 'claude';
  return 'claude';
}

/// Collapsed model display for tight UI spots.
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  // claude-opus-4-7 → opus 4.7
  const m = model.replace(/^claude-/, '').replace(/-/g, ' ');
  return m;
}
