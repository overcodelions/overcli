import { promises as fsp } from 'node:fs';
import path from 'node:path';

/// The git repos sitting directly inside `dir`, when `dir` is not a repo
/// itself. Picking `~/code/acme` that holds `acme-web`, `acme-api` and
/// `acme-infra` is almost always "these belong together", which is the one
/// moment a workspace explains itself — so the add-folder path asks.
///
/// One level only: related repos sit side by side, and walking deeper would
/// turn a vendored checkout or a submodule into a suggestion.
export async function findChildRepos(dir: string): Promise<string[]> {
  if (!dir || (await isRepo(dir))) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
  const flags = await Promise.all(candidates.map((p) => isRepo(p)));
  return candidates.filter((_, i) => flags[i]).sort((a, b) => a.localeCompare(b));
}

/// `.git` is a directory in a normal clone and a file in a worktree or a
/// submodule; either one makes the folder a repo.
async function isRepo(dir: string): Promise<boolean> {
  return fsp.access(path.join(dir, '.git')).then(() => true, () => false);
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
export async function inspectFolder(dir: string, isDocument: (file: string) => boolean): Promise<FolderKind> {
  if (!dir) return { kind: 'other' };
  if (await isRepo(dir)) return { kind: 'repo' };
  const repoPaths = await findChildRepos(dir);
  if (repoPaths.length >= 2) return { kind: 'repos', repoPaths };

  let rootEntries: import('node:fs').Dirent[];
  try {
    rootEntries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  if (rootEntries.some((e) => e.isFile() && CODE_MARKERS.has(e.name))) return { kind: 'other' };

  // Two levels is enough to see a documents folder for what it is, and cheap
  // enough to run on every pick — this blocks the add, so it stays bounded.
  let files = 0;
  let docs = 0;
  const walk = async (at: string, depth: number): Promise<boolean> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(at, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (files >= SCAN_LIMIT) return false;
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) {
        files++;
        if (isDocument(e.name)) docs++;
      } else if (e.isDirectory() && depth === 0 && !SKIP_DIRS.has(e.name)) {
        if (await walk(path.join(at, e.name), depth + 1)) return true;
      }
    }
    return false;
  };
  const looksLikeCode = await walk(dir, 0);
  if (looksLikeCode || docs === 0) return { kind: 'other' };
  return docs / files >= 0.6 ? { kind: 'documents' } : { kind: 'other' };
}
