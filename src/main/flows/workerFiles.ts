// A worker's own directory on disk — its filing cabinet.
//
// Two things live here, and the second is why it is a directory rather than a
// list of run artifacts:
//
//   1. DELIVERABLES the engine files automatically. A flow run's artifacts are
//      deleted with the run (`MAX_RETAINED_RUNS = 50`, checkpoint and all), so
//      a worker's output was on a timer measured in days. Copying the final
//      artifact here at completion is what makes "what did this worker produce
//      last month" answerable at all.
//   2. WHATEVER THE WORKER WRITES ITSELF during a shift or errand. The journal
//      records what happened; this is where the worker keeps what it needs to
//      do the job — a running baseline to diff against, a tally, notes it
//      leaves for its next shift. Memory it can read back, not just a log the
//      user reads.
//
// It lives under userData, not in the project: worker output is not source,
// and a daily-report worker would otherwise litter every repo it touches. It
// survives firing, matching the existing rule that removing a worker removes
// the persona, not its output.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';

/// Biggest file we will read back into the renderer. A worker told to keep a
/// baseline can write something enormous; the list still shows it, but the
/// viewer refuses rather than shipping 40MB over IPC.
export const WORKER_FILE_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkerFileEntry {
  /// Path relative to the worker's root, POSIX-separated. Doubles as the id.
  name: string;
  /// Absolute path, so the renderer can hand it to the ordinary file preview
  /// instead of a bespoke viewer. Worker files, unlike flow artifacts, are
  /// real files on disk — there is no reason to invent a second way to read
  /// a markdown file.
  path: string;
  bytes: number;
  modifiedAt: number;
}

function workersRoot(): string {
  try {
    return path.join(app.getPath('userData'), 'worker-files');
  } catch {
    return path.join(process.cwd(), '.overcli-test-worker-files');
  }
}

/// The absolute path a worker owns. Handed to the worker in its own prompt, so
/// its flow steps can read and write it with ordinary tools — no mounting into
/// the worktree, no runtime change. The id is a UUID, so it is already safe as
/// a path segment; guard anyway rather than trust a caller.
export function workerFilesDir(workerId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(workerId)) throw new Error(`Unsafe worker id: ${workerId}`);
  return path.join(workersRoot(), workerId);
}

export function ensureWorkerFilesDir(workerId: string): string {
  const dir = workerFilesDir(workerId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/// Everything the worker has, newest first, walking subdirectories — a worker
/// that organises its own notes into folders should not have them vanish from
/// the list because the reader only looked one level deep.
export function listWorkerFiles(workerId: string): WorkerFileEntry[] {
  const root = workerFilesDir(workerId);
  const out: WorkerFileEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // never written to — an empty cabinet, not an error
    }
    for (const entry of entries) {
      // Finder writes .DS_Store into any directory the user browses, and it
      // was showing up in the Files tab as one of the worker's own notes.
      // Nothing a worker files starts with a dot.
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        out.push({ name: rel, path: full, bytes: stat.size, modifiedAt: stat.mtimeMs });
      } catch {
        // Raced with a delete; skip it.
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/// Read one file back. `name` is caller-supplied and therefore hostile: resolve
/// it and require the result to stay inside the worker's own directory, so a
/// `../../` can't read the user's home.
export function readWorkerFile(
  workerId: string,
  name: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const root = workerFilesDir(workerId);
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, error: 'That path is outside the worker’s files.' };
  }
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: 'Not a file.' };
    if (stat.size > WORKER_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `Too big to preview (${Math.round(stat.size / 1024)}KB). Open it on disk.`,
      };
    }
    return { ok: true, body: fs.readFileSync(full, 'utf-8') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// File a finished run's deliverable under the worker. Named for what produced
/// it — `shift-007-…`, `errand-…` — so the directory reads as a work history
/// rather than a pile of ids.
///
/// Never overwrites: if the same name is already there, the copy is skipped.
/// This is called from the journal fold, which re-runs on every orchestration
/// update and at startup, so it has to be idempotent for the same reason the
/// journal's append is.
export function fileWorkerDeliverable(args: {
  workerId: string;
  task: 'shift' | 'errand';
  /// The batch's ledger title — `[Shift 3] Warden` or `[Errand] <what you asked>`.
  label: string;
  title: string;
  at: number;
  /// Every artifact the run produced, in step order. The last is the answer;
  /// the earlier ones are what it was built from — a report that cites
  /// `raw_test_output.md` is not much use with that file deleted alongside the
  /// run, so the whole set comes across together.
  artifacts: Array<{ name: string; body: string }>;
}): { written: boolean; name: string } {
  if (args.artifacts.length === 0) return { written: false, name: '' };
  const dir = ensureWorkerFilesDir(args.workerId);
  const stem = existingJobStem(dir, args) ?? deliverableName({ ...args, extension: '' });

  // One artifact is a file; several are a folder, so the supporting material
  // travels with the answer instead of scattering four rows across the list
  // for every run.
  if (args.artifacts.length === 1) {
    const only = args.artifacts[0];
    const name = `${stem}${extensionOf(only.name)}`;
    return writeOnce(path.join(dir, name), only.body, name);
  }

  const folder = path.join(dir, stem);
  let wroteAny = false;
  for (const artifact of args.artifacts) {
    const base = safeBase(artifact.name);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (err) {
      log('error', 'worker-files', `could not create ${stem}`, err);
      return { written: false, name: stem };
    }
    if (writeOnce(path.join(folder, base), artifact.body, base).written) wroteAny = true;
  }
  return { written: wroteAny, name: stem };
}

/// The folder (or file stem) this job was ALREADY filed under, if any.
///
/// The fold re-files on every orchestration update and at startup, and it is
/// idempotent by filename — so a change to how the subject is slugged would
/// otherwise re-file every still-retained run under a second name, and the
/// Files tab would show one errand twice.
///
/// Matching is stamp + kind AND one subject being a prefix of the other, not
/// stamp + kind alone: two different jobs can finish inside the same minute,
/// and folding those together would file one run's output into another run's
/// folder — a far worse failure than a duplicate. Every slug change so far has
/// been a truncation of the same cleaned string, which is what makes the
/// prefix test sufficient.
function existingJobStem(
  dir: string,
  args: { task: 'shift' | 'errand'; label: string; title: string; at: number },
): string | null {
  const want = deliverableName({ ...args, extension: '' });
  try {
    for (const entry of fs.readdirSync(dir)) {
      const base = entryStem(dir, entry);
      if (base === want) return base;
      if (base.startsWith(want) || want.startsWith(base)) return base;
    }
  } catch {
    // Nothing filed yet.
  }
  return null;
}

function entryStem(dir: string, entry: string): string {
  try {
    if (fs.statSync(path.join(dir, entry)).isDirectory()) return entry;
  } catch {
    return entry;
  }
  const dot = entry.lastIndexOf('.');
  return dot > 0 ? entry.slice(0, dot) : entry;
}

/// Never overwrites. The journal fold that calls this re-runs on every
/// orchestration update and at startup, so it has to be idempotent for the
/// same reason the journal's append is.
function writeOnce(full: string, body: string, name: string): { written: boolean; name: string } {
  try {
    if (fs.existsSync(full)) return { written: false, name };
    fs.writeFileSync(full, body, 'utf-8');
    return { written: true, name };
  } catch (err) {
    log('error', 'worker-files', `could not file ${name}`, err);
    return { written: false, name };
  }
}

/// An artifact's own name becomes a filename, so it has to be a safe basename.
function safeBase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned || 'artifact.md';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext : '.md';
}

/// `2026-08-16-1031-errand-why-is-ci-slow.md`
///
/// Date first so the directory sorts chronologically in any file manager and
/// answers "when" without opening anything — these are an archive, and the
/// question you bring to an archive is usually a date.
///
/// Then what produced it, then the subject, and nothing else. The old scheme
/// slugged the whole ledger title into the name, which gave you
/// `shift-shift-3-warden-…`: the word "shift" twice and the worker's own name
/// repeated inside the worker's own directory.
export function deliverableName(args: {
  task: 'shift' | 'errand';
  label: string;
  title: string;
  at: number;
  extension?: string;
}): string {
  const stamp = timestamp(args.at);
  // A shift's number is the only part of its label worth keeping; an errand's
  // subject is already the candidate title.
  const shiftNumber = /\[Shift\s+(\d+)\]/i.exec(args.label)?.[1];
  const kind = args.task === 'shift' && shiftNumber ? `shift-${shiftNumber}` : args.task;
  return `${stamp}-${kind}-${slug(args.title)}${args.extension ?? ''}`;
}

/// Local time, not UTC: the filename is read by a person looking for what
/// happened on their Tuesday morning.
function timestamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/// A filename-safe subject, cut at a WORD boundary.
///
/// A hard slice mid-word produced `…-ziftprocessor-test-c`, which reads as a
/// typo rather than an abbreviation and is worse than the shorter honest form.
/// The cut stays a pure truncation of the same cleaned string — see
/// `existingJobStem`, which relies on an older, shorter name still being a
/// prefix of the one this would produce today.
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'untitled';
  if (cleaned.length <= SLUG_MAX) return cleaned;
  const cut = cleaned.slice(0, SLUG_MAX + 1);
  const lastDash = cut.lastIndexOf('-');
  // No dash in the window means one very long word; keeping the hard cut is
  // better than returning nothing.
  return lastDash > 0 ? cut.slice(0, lastDash) : cleaned.slice(0, SLUG_MAX);
}

const SLUG_MAX = 48;

/// The files a finished item was filed as — the on-disk copies, not the run's
/// artifacts.
///
/// The desk asks for these by the same four facts the filing used, so the
/// naming rule stays in ONE place: the renderer would otherwise have to
/// reproduce `deliverableName` exactly, and any drift between the two would
/// show up as a deliverable that silently refuses to open. Returns empty when
/// nothing was filed (a run that predates filing, or one that produced
/// nothing), which the caller can render honestly rather than as a dead link.
export function deliverableFiles(args: {
  workerId: string;
  task: 'shift' | 'errand';
  label: string;
  title: string;
  at: number;
}): WorkerFileEntry[] {
  const dir = workerFilesDir(args.workerId);
  // Whatever the job is actually filed under — which for anything filed before
  // a naming change is not what `deliverableName` would produce today.
  const stem = existingJobStem(dir, args) ?? deliverableName({ ...args, extension: '' });
  const folder = path.join(dir, stem);
  const out: WorkerFileEntry[] = [];
  try {
    if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const full = path.join(folder, entry.name);
        const stat = fs.statSync(full);
        out.push({
          name: `${stem}/${entry.name}`,
          path: full,
          bytes: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }
    // A single-artifact run is filed as one file, not a folder — its extension
    // came from the artifact's own name, so look for any of them.
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name !== stem && !entry.name.startsWith(`${stem}.`)) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      out.push({ name: entry.name, path: full, bytes: stat.size, modifiedAt: stat.mtimeMs });
    }
  } catch {
    // Never filed, or the directory is gone. An empty list is the truth.
  }
  return out;
}

/// Delete one job — a folder and everything in it, or a single loose file.
///
/// `name` is caller-supplied and therefore hostile: the same containment check
/// the reader uses applies, plus a refusal to delete the worker's ROOT. A
/// `..` that resolved to the parent would otherwise take out every worker's
/// files, and a bare `.` would empty this one's.
export function deleteWorkerFile(
  workerId: string,
  name: string,
): { ok: true; removed: string } | { ok: false; error: string } {
  const root = workerFilesDir(workerId);
  const full = path.resolve(root, name);
  if (full === root) return { ok: false, error: 'That is the worker’s whole directory.' };
  if (!full.startsWith(root + path.sep)) {
    return { ok: false, error: 'That path is outside the worker’s files.' };
  }
  try {
    if (!fs.existsSync(full)) return { ok: false, error: 'Already gone.' };
    fs.rmSync(full, { recursive: true, force: true });
    return { ok: true, removed: name };
  } catch (err) {
    log('error', 'worker-files', `could not delete ${name}`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
