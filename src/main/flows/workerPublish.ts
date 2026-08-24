// Delivering a worker's output to an everyday project's own folder.
//
// `workerFiles` is the archive: every deliverable, kept past the run that made
// it, under `userData` so a daily-report worker cannot litter a repo. That is
// the right default for a project with git, a review step, and an owner who
// knows what `userData` is.
//
// It is the wrong one for an everyday project, where the folder IS the app.
// Someone who asked a worker for a summary of the course material opens the
// documents grid, and a file that exists only under
// `worker-files/<uuid>/[Shift 3] …` has not been delivered to them.
//
// So the deliverable is FILED here at completion — copied once, on success,
// by Overcli. The run itself never gains write access to the project: the
// boundary in `buildWorkerRunBoundary` still points it at a disposable root
// and marks the real folder read-only, which is what keeps half-finished
// drafts and stale absolute paths out of someone's Documents.

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../diagnostics';
import { hasEverydayMarker, uniqueFilePath } from '../everydayProject';
import { isDocumentLikePath } from '../../shared/everydayProjects';
import { workerFilesDir } from './workerFiles';

/// Ledger of runs already published, inside the worker's own directory. Named
/// with a leading dot so `listWorkerFiles` skips it — it is bookkeeping, not
/// one of the worker's notes.
///
/// This exists because the engine's fold is not a one-shot: it re-runs on
/// every orchestration update and again at startup. `fileWorkerDeliverable`
/// survives that by being idempotent by filename; publishing cannot be,
/// because the project copy deliberately never overwrites — without a ledger,
/// one finished shift would deposit `Summary.md`, `Summary 2.md`,
/// `Summary 3.md` … every time the app reopened.
const PUBLISH_LEDGER = '.published.json';

/// Biggest single file to copy across. Everyday projects checkpoint into git,
/// which can never reclaim a reachable blob, so a worker that renders a huge
/// binary every morning would grow someone's Documents folder without bound.
/// It stays in the cabinet, which is pruned by compaction and is not a repo.
export const PUBLISH_MAX_BYTES = 25 * 1024 * 1024;

/// A worker's model-generated HTML previews under a script-running policy, so
/// it is the one document-like extension that must not be filed into a live
/// folder and committed as if a person put it there.
function isPublishable(name: string): boolean {
  return isDocumentLikePath(name) && !/\.html?$/i.test(name);
}

export interface PublishArtifact {
  name: string;
  body?: string;
  sourcePath?: string;
}

export interface PublishResult {
  /// Filenames as they landed in the project, which is not necessarily what
  /// was asked for — a second `Summary.md` becomes `Summary 2.md`.
  written: string[];
  /// Documents that were too large to file. The cabinet still has them.
  skippedNames?: string[];
  /// Why nothing was written, when nothing was. Only for the log.
  skipped?: 'not-everyday' | 'already-published' | 'no-documents';
}

/// Copy a finished run's document-like artifacts into the project folder.
///
/// Only documents travel. A run told to build a deck may also write
/// `build_deck.py` and a shell script to regenerate it, and dropping those in
/// front of someone who came to read a marketing brief is worse than dropping
/// nothing — the same reasoning that shapes `DOCUMENT_EXTS`. Everything else
/// is still in the cabinet for anyone who wants it.
export function publishDeliverableToProject(args: {
  workerId: string;
  projectPath: string;
  /// Idempotency key: the run whose deliverable this is.
  runId: string;
  artifacts: ReadonlyArray<PublishArtifact>;
}): PublishResult {
  // The marker, not the app's store, is what says "everyday" — it is the one
  // signal that survives the folder being moved, copied to a second machine,
  // or handed to a colleague. A folder without it is a code project as far as
  // this is concerned, and code projects are never published into.
  if (!hasEverydayMarker(args.projectPath)) return { written: [], skipped: 'not-everyday' };

  const ledger = readLedger(args.workerId);
  if (ledger[args.runId]) return { written: [], skipped: 'already-published' };

  const documents = args.artifacts.filter((a) => isPublishable(a.name));
  if (documents.length === 0) {
    // Recorded anyway: a run that produced no documents will not start
    // producing them on the next re-fold, and the entry stops this rescanning
    // the same run forever.
    writeLedger(args.workerId, { ...ledger, [args.runId]: [] });
    return { written: [], skipped: 'no-documents' };
  }

  const written: string[] = [];
  const skippedNames: string[] = [];
  for (const artifact of documents) {
    const base = safeBase(artifact.name);
    if (!base) continue;
    try {
      if (artifact.sourcePath) {
        if (fs.statSync(artifact.sourcePath).size > PUBLISH_MAX_BYTES) {
          skippedNames.push(base);
          log('warn', 'worker-publish', `${base} is too large to file into the folder; it stays in the cabinet`);
          continue;
        }
        const dest = uniqueFilePath(args.projectPath, base);
        fs.copyFileSync(artifact.sourcePath, dest);
        written.push(path.basename(dest));
        continue;
      }
      const body = artifact.body ?? '';
      if (Buffer.byteLength(body, 'utf-8') > PUBLISH_MAX_BYTES) {
        skippedNames.push(base);
        log('warn', 'worker-publish', `${base} is too large to file into the folder; it stays in the cabinet`);
        continue;
      }
      const dest = uniqueFilePath(args.projectPath, base);
      fs.writeFileSync(dest, body, 'utf-8');
      written.push(path.basename(dest));
    } catch (err) {
      // One unreadable artifact must not cost the user the rest of the
      // delivery, and the cabinet copy is unaffected either way.
      log('error', 'worker-publish', `could not file ${artifact.name}`, err);
    }
  }

  writeLedger(args.workerId, { ...ledger, [args.runId]: written });
  return skippedNames.length > 0 ? { written, skippedNames } : { written };
}

/// Same shape as `copyIntoProject`: a basename, never a path, and never a
/// dotfile. `name` reaches here from a flow's own step output, so it is not
/// trusted to stay inside the folder.
function safeBase(name: string): string {
  return path.basename(String(name ?? '')).replace(/^\.+/, '').trim();
}

type Ledger = Record<string, string[]>;

function ledgerPath(workerId: string): string {
  return path.join(workerFilesDir(workerId), PUBLISH_LEDGER);
}

function readLedger(workerId: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(workerId), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Ledger) : {};
  } catch {
    // Absent or corrupt. Both mean "nothing published yet" — the cost of
    // being wrong is one duplicate document, not a failed delivery.
    return {};
  }
}

function writeLedger(workerId: string, ledger: Ledger): void {
  try {
    const file = ledgerPath(workerId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
  } catch (err) {
    log('error', 'worker-publish', 'could not record publication', err);
  }
}
