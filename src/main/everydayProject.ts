import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVERYDAY_PROJECTS_DIRNAME } from '../shared/everydayProjects';

export function everydayProjectsRoot(): string {
  const docs = path.join(os.homedir(), 'Documents');
  const base = fs.existsSync(docs) ? docs : os.homedir();
  return path.join(base, EVERYDAY_PROJECTS_DIRNAME);
}

/// Folder-safe name: keep letters, digits, spaces, dash; collapse the rest.
/// Dropping `/`, `\` and `.` also makes a hostile title traversal-proof.
export function folderNameFor(title: string): string {
  const cleaned = title.replace(/[^a-zA-Z0-9 \-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 60) || 'New project';
}

/// Marker written into an everyday project's own folder.
///
/// Everything else that knows a project is "everyday" lives in the app's
/// store, keyed by an id — so it is lost the moment the folder outlives that
/// record: a reinstall, a second machine, a folder handed to a colleague. A
/// file in the folder is the only thing that survives all of those, and it
/// replaces a path heuristic that would otherwise claim any directory a user
/// happened to name "Overcli Projects".
///
/// Deliberately a MARKER, not a settings file. A name like
/// `.overcli-settings` invites folder-local config that would end up fighting
/// app config; this answers one question and nothing else.
export const EVERYDAY_MARKER_FILE = '.overcli-project.json';

export function writeEverydayMarker(projectPath: string): void {
  try {
    fs.writeFileSync(
      path.join(projectPath, EVERYDAY_MARKER_FILE),
      `${JSON.stringify({ kind: 'everyday', version: 1 }, null, 2)}\n`,
      'utf-8',
    );
  } catch {
    // Best effort. A project without its marker still works here and now;
    // it just will not recognise itself somewhere else.
  }
}

export function hasEverydayMarker(projectPath: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(projectPath, EVERYDAY_MARKER_FILE), 'utf-8');
    return JSON.parse(raw)?.kind === 'everyday';
  } catch {
    // Absent, unreadable, or not JSON — all mean "no marker", never an error.
    return false;
  }
}

/// Read every project's marker in one pass, and back-fill one for a project
/// the store already knows is everyday. Healing on read is what makes folders
/// scaffolded before markers existed portable from now on; it never INVENTS
/// everyday-ness for a folder that was not already one.
export function syncProjectMarkers(
  projects: ReadonlyArray<{ path: string; everyday?: boolean }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const project of projects) {
    if (!project.path) continue;
    const marked = hasEverydayMarker(project.path);
    if (!marked && project.everyday === true) {
      writeEverydayMarker(project.path);
      out[project.path] = true;
      continue;
    }
    out[project.path] = marked;
  }
  return out;
}

export function createEverydayProject(
  args: { title: string; goal: string },
): { ok: true; path: string } | { ok: false; error: string } {
  const root = everydayProjectsRoot();
  let dir = path.join(root, folderNameFor(args.title));
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(root, `${folderNameFor(args.title)} ${n++}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'BRIEF.md'),
      `# ${args.title}\n\n## What I want\n\n${args.goal.trim()}\n`,
      'utf-8',
    );
    writeEverydayMarker(dir);
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// Drop-target write behind the files bubble. The renderer reads dropped
/// files with `FileReader` (Electron no longer exposes `File.path`), so what
/// arrives here is name + bytes rather than a source path to copy from.
///
/// Files land directly in the project folder. There is deliberately no
/// `inbox/` — separating "what I gave it" from "what it made" is the job the
/// undo history already does, and a folder convention that duplicates it is
/// one more thing to teach someone who came here to review a document.
///
/// Each name is reduced to its basename, so nothing can climb out of
/// `projectPath` no matter what the renderer sends.
export function copyIntoProject(
  args: { projectPath: string; files: Array<{ name: string; dataBase64: string }> },
): { ok: true; written: number } | { ok: false; error: string } {
  const dest = args.projectPath;
  if (!Array.isArray(args.files) || args.files.length === 0) {
    return { ok: false, error: 'Nothing to add.' };
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    let written = 0;
    for (const file of args.files) {
      const base = path.basename(String(file?.name ?? '')).replace(/^\.+/, '').trim();
      if (!base) continue;
      fs.writeFileSync(uniqueFilePath(dest, base), Buffer.from(file.dataBase64, 'base64'));
      written += 1;
    }
    if (written === 0) return { ok: false, error: 'Nothing to add.' };
    return { ok: true, written };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// `report.csv` dropped twice becomes `report.csv` and `report 2.csv` rather
/// than one file silently replacing the other — these are the user's own
/// documents, and an overwrite is not recoverable from inside the app.
function uniqueFilePath(dir: string, base: string): string {
  let candidate = path.join(dir, base);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${n}${ext}`);
    n += 1;
  }
  return candidate;
}
