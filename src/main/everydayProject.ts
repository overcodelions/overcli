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
