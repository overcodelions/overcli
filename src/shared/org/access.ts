// How much the org's workers may do on the server, as one level an admin
// picks on Setup → Workers → Permissions. Shared: the console names the
// levels the same way the server enforces them.

export type AccessLevel = 'read' | 'standard' | 'shell' | 'everything';

export const ACCESS_LEVELS: AccessLevel[] = ['read', 'standard', 'shell', 'everything'];

export interface WorkerAccess {
  level: AccessLevel;
  /// Under `shell`: the commands workers may run, by how they start
  /// (`npm test`, `jq`, `python scripts/report.py`). Anything else is refused.
  commands?: string[];
  /// More tools by name, at any level: one connector's writes
  /// (`mcp__zendesk__create_ticket`) without opening every tool.
  tools?: string[];
}

/// Tools that only look: every level has them.
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
/// Tools that change files, from `standard` up.
export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/// In an allow-list: anything at all (the `everything` level).
export const ANY_TOOL = '*';

export function rank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

/// A command as the CLI's narrowed grant: `Bash(npm test:*)`.
export function commandGrant(command: string): string | null {
  const c = command.trim().replace(/\s+/g, ' ');
  if (!c || c.length > 200 || /[()`$;&|<>\n]/.test(c)) return null;
  return `Bash(${c}:*)`;
}

/// The allow-list a level comes to, capped at what the server allows.
export function accessTools(access: WorkerAccess, ceiling: AccessLevel): string[] {
  const level = rank(access.level) > rank(ceiling) ? ceiling : access.level;
  const out = [...READ_TOOLS];
  if (rank(level) >= rank('standard')) out.push(...WRITE_TOOLS);
  if (level === 'shell') for (const c of access.commands ?? []) {
    const g = commandGrant(c);
    if (g) out.push(g);
  }
  if (level === 'everything') out.push('Bash', ANY_TOOL);
  for (const t of access.tools ?? []) if (/^[\w.-]{1,120}$/.test(t)) out.push(t);
  return [...new Set(out)];
}

/// The highest level a server's own allow-list reaches: what its operator
/// already let workers do without the console.
export function levelOf(allowTools: readonly string[]): AccessLevel {
  if (allowTools.includes('Bash') || allowTools.includes(ANY_TOOL)) return 'everything';
  if (allowTools.some((t) => t.startsWith('Bash('))) return 'shell';
  if (allowTools.some((t) => WRITE_TOOLS.includes(t))) return 'standard';
  return 'read';
}

export const ACCESS_WORDS: Record<AccessLevel, { name: string; what: string }> = {
  read: { name: 'Read only', what: 'Read files and the web, and use tools only to look things up. Nothing is changed.' },
  standard: { name: 'Standard', what: 'Also edit and write files in their own folders and the repos they work in. Shell commands only to read their own files.' },
  shell: { name: 'Shell for listed commands', what: 'Also run the commands you list below, such as npm test or jq. Any other command is refused.' },
  everything: { name: 'Everything', what: 'Any tool and any shell command, without asking. Only for a server whose network and keys you would hand a person.' },
};
