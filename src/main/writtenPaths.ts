// Files an agent wrote during this session, and whether one may be READ back.
//
// The file viewer only opens paths under a registered project, workspace or
// worktree (`isPathUnderRegisteredRoot`). That is the right rule for writing,
// and the wrong one for reading an agent's own scratch: a step that maps 39
// chunks through `/tmp` renders 39 WRITE cards in the transcript that the app
// then refuses to open. It protects nothing — the run created those files and
// their contents already passed through the user's context — while making
// every one of those cards a dead link.
//
// So the rule here is PROVENANCE, not location: a path is readable if this
// session watched a tool write it. An arbitrary path a model merely NAMES
// ("open /etc/passwd") is still refused, because nothing recorded creating it.
//
// Deliberately narrow:
//   - Reads only. Writes keep the strict registered-root rule, so the editor
//     can show you a `/tmp` chunk but cannot save back into it.
//   - In memory only. The set dies with the app; a widened boundary should
//     never outlive the session that earned it.
//   - Bounded. Oldest entries evict, so a long-running map/reduce can't grow
//     it without limit.

import fs from 'node:fs';
import path from 'node:path';

import type { StreamEvent } from '../shared/types';

/// Tools whose invocation means "this file now exists because the agent made
/// it". Read/Grep/Glob are absent on purpose — naming a file is not creating
/// one, and honouring a Read would let a model launder any path into the
/// allowlist just by trying to read it first.
const WRITING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'create_file',
  'edit_file',
  'write_file',
  'str_replace_editor',
]);

/// Tools that take a file the session already made and send it somewhere.
/// They don't create the file, so they aren't writing tools — but their
/// `file_path` is provenance just as strong: this session handed that exact
/// file to a remote service, so its contents have demonstrably already left
/// the machine. Refusing to show the user the thing we just published on
/// their behalf protects nothing.
///
/// This is what makes a `/design` canvas openable. The skill builds it by
/// running `seed-canvas.mjs` through Bash — never through Write — so the
/// writing-tool rule above never sees it, and the file lands in the session
/// scratchpad rather than under a registered root. The Artifact call that
/// publishes it is the only event that names the path.
const PUBLISHING_TOOLS = new Set(['Artifact']);

/// Tools whose `file_path` earns that path a place in the readable set,
/// whether it was written locally or published outward.
function recordsProvenance(name: string | undefined): boolean {
  return isWritingTool(name) || (!!name && PUBLISHING_TOOLS.has(name));
}

/// Enough for a long map/reduce shift; small enough that the set stays cheap
/// to scan and can't become a memory leak on a machine left running for days.
const MAX_TRACKED_PATHS = 5_000;

/// Insertion-ordered, so eviction is "oldest first" for free.
const written = new Set<string>();

export function isWritingTool(name: string | undefined): boolean {
  return !!name && WRITING_TOOLS.has(name);
}

/// Record a path an agent just wrote. Absolute paths only: a relative hint
/// would be resolved against the main process cwd, which in a dev build is
/// the overcli checkout itself.
export function recordWrittenPath(target: string | undefined): void {
  if (!target || !path.isAbsolute(target)) return;
  const key = canonical(target);
  if (!key) return;
  // Re-writing a file moves it to the back of the eviction queue: a path the
  // run keeps touching is the one most likely to be opened.
  written.delete(key);
  written.add(key);
  if (written.size > MAX_TRACKED_PATHS) {
    const oldest = written.values().next();
    if (!oldest.done) written.delete(oldest.value);
  }
}

/// Did this session watch a tool write this exact path? Compared after
/// resolving symlinks on both sides, so `/tmp/x` and `/private/tmp/x` are the
/// same file — and so a symlink planted later cannot alias an allowed path
/// onto a different one.
export function isAgentWrittenPath(target: string): boolean {
  if (!target || !path.isAbsolute(target)) return false;
  const key = canonical(target);
  return !!key && written.has(key);
}

/// A tool USE is a request, not an outcome — the user may still deny it, or it
/// may fail. Writes wait here, keyed by tool_use id, until a non-error result
/// with the same id proves the file actually landed. Bounded, and results can
/// arrive in a later batch than the use that asked for them.
const pendingWrites = new Map<string, string>();

/// Harvest the writes out of a batch of stream events. Split from the IPC
/// bridge that calls it so the rule — which tools count, which paths are
/// taken — is testable without an Electron window.
export function recordWritesFromEvents(events: readonly StreamEvent[]): void {
  for (const event of events) {
    if (event.kind.type === 'assistant') {
      for (const use of event.kind.info.toolUses ?? []) {
        if (recordsProvenance(use.name) && use.filePath) {
          pendingWrites.set(use.id, use.filePath);
          if (pendingWrites.size > MAX_TRACKED_PATHS) {
            const oldest = pendingWrites.keys().next();
            if (!oldest.done) pendingWrites.delete(oldest.value);
          }
        }
      }
      continue;
    }
    if (event.kind.type !== 'toolResult') continue;
    for (const result of event.kind.results ?? []) {
      const target = pendingWrites.get(result.id);
      if (target === undefined) continue;
      pendingWrites.delete(result.id);
      if (!result.isError) recordWrittenPath(target);
    }
  }
}

/// Test seam. Nothing in the app clears the set — it is session-scoped.
export function resetWrittenPathsForTest(): void {
  written.clear();
  pendingWrites.clear();
}

/// Resolve a path to compare by identity rather than spelling. Falls back to
/// the lexically-resolved path when the file isn't there (yet): a Write event
/// can arrive fractionally before the file lands, and the same fallback is
/// applied on both sides so the two spellings still meet.
function canonical(target: string): string | null {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
