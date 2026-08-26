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

/// How long to keep retrying an artifact whose write threw before giving up.
///
/// Counting attempts would be wrong: the fold re-runs on every orchestration
/// update, so a network volume unmounted for ten seconds could burn through an
/// attempt budget and be written off while it is still coming back. A time
/// window gives a real outage room to resolve, while still letting an artifact
/// whose source is simply gone stop asking — otherwise it is retried, and
/// logged, on every fold for the life of the run.
export const PUBLISH_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /// Injected so the retry window is testable without waiting a day.
  now?: number;
}): PublishResult {
  const now = args.now ?? Date.now();
  // The marker, not the app's store, is what says "everyday" — it is the one
  // signal that survives the folder being moved, copied to a second machine,
  // or handed to a colleague. A folder without it is a code project as far as
  // this is concerned, and code projects are never published into.
  if (!hasEverydayMarker(args.projectPath)) return { written: [], skipped: 'not-everyday' };

  const ledger = readLedger(args.workerId);
  const entry = ledger[args.runId];
  // A pre-0.16.2 ledger meant "this run is fully published" the instant any
  // entry existed at all — `readLedger` marks those `legacyComplete`. Honour
  // that as-is rather than partially trusting the array as `doneNames`: the
  // old array held LANDED (uniquified) filenames like `Summary 2.md`, which
  // would never match an original artifact name and would re-file it.
  if (entry?.legacyComplete) return { written: [], skipped: 'already-published' };
  // Named by the ORIGINAL artifact name, not the uniquified filename it lands
  // as — that's what lets a retry recognize "already filed" even though the
  // destination name (`Summary 2.md`) depends on what else is in the folder.
  const doneNames = new Set(entry?.doneNames ?? []);
  const failedSince: Record<string, number> = { ...(entry?.failedSince ?? {}) };
  const documents = args.artifacts.filter((a) => isPublishable(a.name));
  const remaining = documents.filter((d) => {
    const base = safeBase(d.name);
    return base && !doneNames.has(base);
  });

  // Everything this run was ever going to publish already landed (or was
  // permanently skipped as too-large) on an earlier fold.
  if (entry && remaining.length === 0) return { written: [], skipped: 'already-published' };

  if (documents.length === 0) {
    // Recorded anyway: a run that produced no documents will not start
    // producing them on the next re-fold, and the entry stops this rescanning
    // the same run forever.
    writeLedger(args.workerId, { ...ledger, [args.runId]: { written: [], doneNames: [] } });
    return { written: [], skipped: 'no-documents' };
  }

  const written: string[] = [];
  const skippedNames: string[] = [];
  for (const artifact of remaining) {
    const base = safeBase(artifact.name);
    if (!base) continue;
    try {
      if (artifact.sourcePath) {
        if (fs.statSync(artifact.sourcePath).size > PUBLISH_MAX_BYTES) {
          skippedNames.push(base);
          doneNames.add(base);
          log('warn', 'worker-publish', `${base} is too large to file into the folder; it stays in the cabinet`);
          continue;
        }
        const dest = uniqueFilePath(args.projectPath, base);
        fs.copyFileSync(artifact.sourcePath, dest);
        written.push(path.basename(dest));
        doneNames.add(base);
        continue;
      }
      const body = artifact.body ?? '';
      if (Buffer.byteLength(body, 'utf-8') > PUBLISH_MAX_BYTES) {
        skippedNames.push(base);
        doneNames.add(base);
        log('warn', 'worker-publish', `${base} is too large to file into the folder; it stays in the cabinet`);
        continue;
      }
      const dest = uniqueFilePath(args.projectPath, base);
      fs.writeFileSync(dest, body, 'utf-8');
      written.push(path.basename(dest));
      doneNames.add(base);
    } catch (err) {
      // One unreadable artifact must not cost the user the rest of the
      // delivery. It is deliberately left OUT of `doneNames`, so the next
      // fold retries only this artifact instead of either re-copying what
      // already landed or leaving the whole run unledgered forever.
      const firstFailedAt = failedSince[base] ?? now;
      const isRetry = failedSince[base] !== undefined;
      failedSince[base] = firstFailedAt;
      // Only the first failure is news. The fold re-runs on every
      // orchestration update, so logging each retry at error level would bury
      // the diagnostics buffer under one unreadable file.
      log(isRetry ? 'debug' : 'error', 'worker-publish', `could not file ${artifact.name}`, err);
      if (now - firstFailedAt >= PUBLISH_RETRY_WINDOW_MS) {
        // Past the window it is not coming back. Settle it so the run can
        // finish, and surface it the same way a too-large document is.
        doneNames.add(base);
        skippedNames.push(base);
        log('warn', 'worker-publish', `${base} could not be filed; it stays in the cabinet`);
      }
    }
  }

  // An artifact that settled — filed, too large, or written off — is never
  // retried, so its failure stamp is dead weight on disk.
  for (const name of doneNames) delete failedSince[name];

  writeLedger(args.workerId, {
    ...ledger,
    [args.runId]: {
      written: [...(entry?.written ?? []), ...written],
      doneNames: [...doneNames],
      ...(Object.keys(failedSince).length > 0 ? { failedSince } : {}),
    },
  });
  return skippedNames.length > 0 ? { written, skippedNames } : { written };
}

/// Same shape as `copyIntoProject`: a basename, never a path, and never a
/// dotfile. `name` reaches here from a flow's own step output, so it is not
/// trusted to stay inside the folder.
function safeBase(name: string): string {
  return path.basename(String(name ?? '')).replace(/^\.+/, '').trim();
}

interface LedgerEntry {
  /// Filenames as they landed in the project, accumulated across every fold
  /// pass for this run — kept for diagnostics, not read back for retry logic.
  written: string[];
  /// Original artifact names (pre-uniquification) that are permanently
  /// settled: either filed successfully or skipped for being too large. A
  /// name absent here is retried on the next fold.
  doneNames: string[];
  /// Epoch ms of the FIRST failed attempt, per original artifact name, for
  /// artifacts still inside the retry window. Pruned once the name settles.
  failedSince?: Record<string, number>;
  /// Set only by `readLedger` when migrating a pre-0.16.2 entry (a bare
  /// filename array). Those meant "this run is fully published" unconditionally
  /// — see the `readLedger` migration for why that can't be expressed by
  /// backfilling `doneNames` instead.
  legacyComplete?: boolean;
}

type Ledger = Record<string, LedgerEntry>;

function ledgerPath(workerId: string): string {
  return path.join(workerFilesDir(workerId), PUBLISH_LEDGER);
}

function readLedger(workerId: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(workerId), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Ledger = {};
    for (const [runId, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Pre-0.16.2 ledgers stored a bare array of landed filenames and meant
      // "this run is fully published". Honour that rather than reinterpreting
      // the array as `doneNames`: those filenames are already-uniquified
      // (`Summary 2.md`), so they'd never match an original artifact name and
      // the run would be re-filed on the first fold after upgrade.
      out[runId] = Array.isArray(value)
        ? { written: value as string[], doneNames: [], legacyComplete: true }
        : (value as LedgerEntry);
    }
    return out;
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
