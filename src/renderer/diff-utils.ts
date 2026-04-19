// Diff/commit helpers shared by the worktree diff + workspace review
// sheets. Kept in the renderer (not shared/) because the commit body
// composition reads runner event state that only lives here.

import { StreamEvent, UUID } from '@shared/types';
import { RunnerState } from './store';

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  body: string;
  isBinary: boolean;
}

/// Split a `git diff` unified-diff string into per-file blocks so the
/// sheet can render a sidebar file list. Matches the Swift
/// DiffParser.parseUnifiedDiff shape.
export function parseUnifiedDiffByFile(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentPath: string | null = null;
  let currentBody: string[] = [];
  let added = 0;
  let removed = 0;
  let isBinary = false;

  const flush = () => {
    if (currentPath == null) return;
    files.push({
      path: currentPath,
      added,
      removed,
      body: currentBody.join('\n'),
      isBinary,
    });
    currentPath = null;
    currentBody = [];
    added = 0;
    removed = 0;
    isBinary = false;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const parts = line.split(' ').filter(Boolean);
      if (parts.length >= 4) {
        const bPath = parts[3];
        currentPath = bPath.startsWith('b/') ? bPath.slice(2) : bPath;
      }
      currentBody.push(line);
      continue;
    }
    currentBody.push(line);
    if (line.startsWith('Binary files')) isBinary = true;
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  flush();
  return files;
}

export interface AgentDescription {
  subject: string;
  body?: string;
}

/// Flatten common markdown noise and cap at a character budget so the
/// commit/PR body stays short and readable. Matches the Swift
/// summariseAssistantText helper.
export function summariseAssistantText(text: string, maxChars: number): string {
  let out = text.replace(/```/g, '');
  const lines = out.split('\n').map((line) => {
    let l = line;
    while (l.length && (l[0] === '#' || l[0] === '>')) {
      l = l.slice(1);
    }
    return l;
  });
  out = lines.join('\n').trim();
  if (out.length <= maxChars) return out;
  return out.slice(0, maxChars).trim() + '…';
}

/// Build a commit/PR description from the conversation name + the last
/// assistant text in the runner's event stream. Falls back to a generic
/// "Overcli: <branch> changes" subject when the conversation still has
/// the default name.
export function agentDescription(
  conversationName: string,
  lastAssistantText: string | null,
  branch: string,
): AgentDescription {
  const trimmedName = conversationName.trim();
  const subject = trimmedName || `Overcli: ${branch} changes`;
  if (!lastAssistantText) return { subject };
  const body = summariseAssistantText(lastAssistantText, 500);
  return { subject, body: body || undefined };
}

/// Last assistant-authored text in the runner's event stream, or null.
export function lastAssistantText(runner: RunnerState | undefined): string | null {
  if (!runner) return null;
  for (let i = runner.events.length - 1; i >= 0; i--) {
    const e: StreamEvent = runner.events[i];
    if (e.kind.type === 'assistant' && e.kind.info.text.trim()) {
      return e.kind.info.text;
    }
  }
  return null;
}

export function fileBaseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

/// Pull the project path this conversation was spawned from. For a
/// workspace-agent member we look across every project; the member's
/// worktree lives under that project's checkout.
export function findOwningProjectPath(
  projects: Array<{ path: string; conversations: Array<{ id: UUID }> }>,
  convId: UUID,
): string | null {
  for (const p of projects) {
    if (p.conversations.some((c) => c.id === convId)) return p.path;
  }
  return null;
}
