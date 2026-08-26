// Which file, if any, a finished turn wrote FOR THE USER TO READ.
//
// Everyday projects already answer this from their own checkpoint: the turn
// commits, and the newest version names the documents it produced. A code
// project has no checkpoint — overcli must never commit someone's repo on
// their behalf — so the only honest record of what a turn made is the turn
// itself, which is what this reads.
//
// Deliberately narrow. The point is the deliverable an agent hands back — the
// summary, the ADR, the migration plan you asked for and then had to go
// hunting for — not "a file changed". Three rules keep it that way:
//
//   1. `Write` only. `Edit` on an existing README is a change to something
//      you already know about; being yanked into it mid-thought is worse
//      than not being shown it.
//   2. Markdown only. It is the format an agent reaches for when the output
//      is prose meant for a person; source, config and data are not.
//   3. A handful at most. A turn that writes eleven markdown files is
//      generating docs, not handing you a document, and picking one of the
//      eleven to open would be picking at random.

import type { StreamEvent } from '@shared/types';
import { isProseDocumentPath } from '@shared/everydayProjects';

/// Past this many written documents the turn is a docs sweep, and there is no
/// single thing it "produced".
const MAX_DOCUMENTS = 3;

/// The file path a Write tool use targeted. `filePath` is pre-parsed for the
/// tools the backends report structurally; the rest carry only the raw
/// arguments, so fall back to the two spellings those use.
function writtenPath(inputJSON: string, filePath?: string): string | null {
  if (filePath) return filePath;
  try {
    const parsed = JSON.parse(inputJSON) as { file_path?: unknown; path?: unknown };
    const raw = parsed.file_path ?? parsed.path;
    return typeof raw === 'string' && raw ? raw : null;
  } catch {
    return null;
  }
}

/// Every document this turn wrote, oldest first, deduped.
///
/// `since` is the turn's start (`runningSince`). Without it the whole
/// transcript counts, so re-opening a conversation and sending "thanks" would
/// resurrect a document written four turns ago.
export function documentsWrittenSince(
  events: readonly StreamEvent[],
  since: number,
): string[] {
  // A Write's toolResult arrives after its assistant event in the stream, so
  // whether a given write was denied/errored can't be known until a later
  // event — hence two passes: collect the failed tool-use ids first, then
  // collect paths, skipping any Write whose id came back an error.
  const failed = new Set<string>();
  for (const e of events) {
    if (e.timestamp < since) continue;
    if (e.kind.type !== 'toolResult') continue;
    for (const result of e.kind.results ?? []) {
      if (result.isError) failed.add(result.id);
    }
  }
  const out: string[] = [];
  for (const e of events) {
    if (e.timestamp < since) continue;
    // A subagent's writes are its own working notes, and its transcript is
    // already a separate place in the UI. The turn's answer is what the main
    // thread hands back.
    if (e.parentToolUseId) continue;
    if (e.kind.type !== 'assistant') continue;
    for (const use of e.kind.info.toolUses) {
      if (use.name !== 'Write') continue;
      if (use.id && failed.has(use.id)) continue;
      const path = writtenPath(use.inputJSON, use.filePath);
      if (!path || !isProseDocumentPath(path)) continue;
      if (!out.includes(path)) out.push(path);
    }
  }
  return out;
}

/// The one document to put in front of the user, or `undefined`.
///
/// The LAST one written, not the first: an agent that writes its notes and
/// then its answer wrote the answer last. Ties are impossible — a turn is a
/// sequence.
export function documentToReveal(
  events: readonly StreamEvent[],
  since: number,
): string | undefined {
  const docs = documentsWrittenSince(events, since);
  if (docs.length === 0 || docs.length > MAX_DOCUMENTS) return undefined;
  return docs[docs.length - 1];
}
