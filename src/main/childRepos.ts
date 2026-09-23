import fs from 'node:fs';
import path from 'node:path';

/// The git repos sitting directly inside `dir`, when `dir` is not a repo
/// itself. Picking `~/code/acme` that holds `acme-web`, `acme-api` and
/// `acme-infra` is almost always "these belong together", which is the one
/// moment a workspace explains itself — so the add-folder path asks.
///
/// One level only: related repos sit side by side, and walking deeper would
/// turn a vendored checkout or a submodule into a suggestion.
export function findChildRepos(dir: string): string[] {
  if (!dir || isRepo(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .filter(isRepo)
    .sort((a, b) => a.localeCompare(b));
}

/// `.git` is a directory in a normal clone and a file in a worktree or a
/// submodule; either one makes the folder a repo.
function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/// Files that say "this is someone's code" even when there is no `.git` yet.
const CODE_MARKERS = new Set([
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'Gemfile', 'pom.xml', 'build.gradle', 'Makefile', 'CMakeLists.txt', 'composer.json',
  'Package.swift', 'mix.exs', 'deno.json',
]);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target']);
const SCAN_LIMIT = 400;

export type FolderKind =
  | { kind: 'repo' }
  | { kind: 'repos'; repoPaths: string[] }
  | { kind: 'documents' }
  | { kind: 'other' };

/// What a folder someone just picked most likely is, so "Open a folder" can
/// do the right thing without first asking them to classify it: a repo opens
/// as code, a folder of repos offers a workspace, and a folder that is mostly
/// documents offers the documents view.
///
/// `isDocument` is passed in rather than imported so the renderer's notion of
/// "a document" (@shared/everydayProjects) stays the single definition.
export function inspectFolder(dir: string, isDocument: (file: string) => boolean): FolderKind {
  if (!dir) return { kind: 'other' };
  if (isRepo(dir)) return { kind: 'repo' };
  const repoPaths = findChildRepos(dir);
  if (repoPaths.length >= 2) return { kind: 'repos', repoPaths };

  // Two levels is enough to see a documents folder for what it is, and cheap
  // enough to run on every pick — this blocks the add, so it stays bounded.
  let files = 0;
  let docs = 0;
  const walk = (at: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (files >= SCAN_LIMIT) return false;
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) {
        if (depth === 0 && CODE_MARKERS.has(e.name)) return true;
        files++;
        if (isDocument(e.name)) docs++;
      } else if (e.isDirectory() && depth === 0 && !SKIP_DIRS.has(e.name)) {
        if (walk(path.join(at, e.name), depth + 1)) return true;
      }
    }
    return false;
  };
  const looksLikeCode = walk(dir, 0);
  if (looksLikeCode || docs === 0) return { kind: 'other' };
  return docs / files >= 0.6 ? { kind: 'documents' } : { kind: 'other' };
}
