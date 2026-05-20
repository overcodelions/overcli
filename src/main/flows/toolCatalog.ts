// Per-backend tool catalog. Powers the builder's "tools" checkbox list.
// v1 returns the known built-in tools for each backend; MCP enumeration
// arrives in a later phase. Tools a backend can't yet execute (e.g.
// write/bash on Ollama) are listed as `available: false` with a tooltip
// so the picker can grey them rather than hide.

import type { Backend } from '../../shared/types';
import type { FlowToolDescriptor } from '../../shared/flows/schema';

const CLAUDE_BUILTINS: Array<Omit<FlowToolDescriptor, 'supportedBackends' | 'available'>> = [
  { id: 'Read', displayName: 'Read', description: 'Read a file from disk.', category: 'builtin' },
  { id: 'Write', displayName: 'Write', description: 'Write a new file.', category: 'builtin' },
  { id: 'Edit', displayName: 'Edit', description: 'Edit an existing file with exact-match replacement.', category: 'builtin' },
  { id: 'Glob', displayName: 'Glob', description: 'Glob for files matching a pattern.', category: 'builtin' },
  { id: 'Grep', displayName: 'Grep', description: 'Search file contents with a regex.', category: 'builtin' },
  { id: 'Bash', displayName: 'Bash', description: 'Run a shell command in the project cwd.', category: 'builtin' },
  { id: 'WebFetch', displayName: 'WebFetch', description: 'Fetch a URL and summarize.', category: 'builtin' },
  { id: 'Task', displayName: 'Task', description: 'Spawn a subagent.', category: 'builtin' },
];

const OLLAMA_BUILTINS: Array<Omit<FlowToolDescriptor, 'supportedBackends' | 'available'>> = [
  { id: 'read_file', displayName: 'read_file', description: 'Read a file from disk.', category: 'builtin' },
  { id: 'list_dir', displayName: 'list_dir', description: 'List entries in a directory.', category: 'builtin' },
  { id: 'grep', displayName: 'grep', description: 'Search file contents with a regex.', category: 'builtin' },
];

function backendFamilyTools(backend: Backend): FlowToolDescriptor[] {
  if (backend === 'ollama') {
    // Ollama's full built-in tool set: read trio + write/edit/bash. All
    // implemented in `ollamaTools.ts` and routed through the tool-call
    // loop with the same safeResolve guards as the read tools.
    const readTools: FlowToolDescriptor[] = OLLAMA_BUILTINS.map(t => ({
      ...t,
      supportedBackends: ['ollama'],
      available: true,
    }));
    const writeTools: FlowToolDescriptor[] = (
      [
        { id: 'write_file', displayName: 'write_file', description: 'Create or overwrite a file.' },
        { id: 'edit_file', displayName: 'edit_file', description: 'Edit an existing file by exact-match replace.' },
        { id: 'bash', displayName: 'bash', description: 'Run a shell command in the project root.' },
      ] as const
    ).map(t => ({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      category: 'builtin' as const,
      supportedBackends: ['ollama'] as Backend[],
      available: true,
    }));
    return [...readTools, ...writeTools];
  }
  // claude, codex, gemini, copilot — surface Claude-family built-ins. Codex
  // and others differ in tool names but the picker is an approximation
  // until per-backend catalogs ship.
  return CLAUDE_BUILTINS.map(t => ({
    ...t,
    supportedBackends: ['claude', 'codex', 'gemini', 'copilot'] as Backend[],
    available: true,
  }));
}

/// Public entry. Today it's a thin wrapper around `backendFamilyTools` but
/// once MCP enumeration lands, that's where new descriptors get merged in.
export function listToolCatalog(args: { backend: Backend }): FlowToolDescriptor[] {
  return backendFamilyTools(args.backend);
}
