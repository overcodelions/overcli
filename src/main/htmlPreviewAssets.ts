// Local subresources for the HTML preview iframe.
//
// The preview iframe is sandboxed (`sandbox=""`), which puts the document
// on an opaque origin, and an opaque-origin document is not allowed to
// load `file://` subresources. So the `<base href="file://…">` we hand it
// can resolve a sibling `styles.css` in theory, but Chromium refuses the
// request in practice and the page renders unstyled. Instead the renderer
// tells us which local refs the document mentions and we read them here —
// inside the same registered-root guard every other fs handler uses — so
// they can be inlined into the document itself.

import fs from 'node:fs';
import path from 'node:path';
import type { HtmlPreviewAsset, HtmlPreviewAssetsResult } from '../shared/types';

/// Per-asset ceiling. Big enough for a real stylesheet or hero image,
/// small enough that a stray video reference can't balloon the srcDoc.
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
/// A generated design page references a handful of files. This is a guard
/// against a pathological document, not a budget anyone should hit.
const MAX_ASSETS = 60;
/// `@import` chains are legal but nesting deeply is not something a
/// preview needs to follow.
const MAX_IMPORT_DEPTH = 4;

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  eot: 'application/vnd.ms-fontobject',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  otf: 'font/otf',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function readHtmlPreviewAssets(
  args: { path: string; rootPath?: string; refs: string[] },
  isReadable: (target: string) => boolean,
): HtmlPreviewAssetsResult {
  const basePath = args?.path ?? '';
  if (!basePath || !path.isAbsolute(basePath) || !isReadable(basePath)) {
    return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
  }
  const baseDir = path.dirname(basePath);
  const assets: Record<string, HtmlPreviewAsset> = {};
  for (const ref of (args?.refs ?? []).slice(0, MAX_ASSETS)) {
    if (typeof ref !== 'string' || ref in assets) continue;
    assets[ref] = readAsset(ref, baseDir, args?.rootPath, isReadable);
  }
  return { ok: true, assets };
}

function readAsset(
  ref: string,
  baseDir: string,
  rootPath: string | undefined,
  isReadable: (target: string) => boolean,
): HtmlPreviewAsset {
  const resolved = resolveRef(ref, baseDir, rootPath, isReadable);
  if (!resolved) return { ok: false, error: `Could not resolve ${ref} from ${baseDir}.` };
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: `${ref} is not a regular file.` };
    if (stat.size > MAX_ASSET_BYTES) return { ok: false, error: `${ref} is too large to inline.` };
    if (extensionOf(resolved) === 'css') {
      return { ok: true, kind: 'css', text: readStylesheet(resolved, isReadable, 0, new Set()) };
    }
    return { ok: true, kind: 'data', dataUrl: toDataUrl(resolved) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? `Could not read ${ref}.` };
  }
}

/// A ref is resolved against the document's own directory first — that's
/// what the browser would do. A root-relative `/assets/app.css` has no
/// meaning without a server, so we also try the project root, which is
/// what an agent writing `/styles.css` almost always meant.
function resolveRef(
  ref: string,
  baseDir: string,
  rootPath: string | undefined,
  isReadable: (target: string) => boolean,
): string | null {
  const relative = toRelativePath(ref);
  if (!relative) return null;
  const candidates = relative.startsWith('/')
    ? [
        rootPath ? path.resolve(rootPath, `.${relative}`) : null,
        path.resolve(baseDir, `.${relative}`),
        relative,
      ]
    : [path.resolve(baseDir, relative)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isReadable(candidate)) continue;
    if (!fs.existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

/// Strip the parts of a URL that never belong to a filesystem path
/// (`?v=3` cache busters, `#fragment`) and undo percent-encoding.
function toRelativePath(ref: string): string | null {
  const trimmed = ref.trim().split('#')[0].split('?')[0];
  if (!trimmed) return null;
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

/// Read a stylesheet and fold its own local dependencies in: `@import`
/// rules become the imported text, `url(...)` refs become data URLs. An
/// inlined `<style>` block has no base URL of its own, so anything left
/// relative would resolve against the document and break.
function readStylesheet(
  cssPath: string,
  isReadable: (target: string) => boolean,
  depth: number,
  seen: Set<string>,
): string {
  if (seen.has(cssPath)) return '';
  seen.add(cssPath);
  const cssDir = path.dirname(cssPath);
  let css = fs.readFileSync(cssPath, 'utf-8');

  css = css.replace(
    /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*([^;]*);/gi,
    (match, ref: string, media: string) => {
      if (depth >= MAX_IMPORT_DEPTH || !isLocalRef(ref)) return match;
      const resolved = resolveRef(ref, cssDir, undefined, isReadable);
      if (!resolved) return match;
      try {
        const imported = readStylesheet(resolved, isReadable, depth + 1, seen);
        const condition = media.trim();
        return condition ? `@media ${condition} {\n${imported}\n}` : imported;
      } catch {
        return match;
      }
    },
  );

  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote: string, ref: string) => {
    if (!isLocalRef(ref)) return match;
    const resolved = resolveRef(ref, cssDir, undefined, isReadable);
    if (!resolved) return match;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return match;
      return `url("${toDataUrl(resolved)}")`;
    } catch {
      return match;
    }
  });

  return css;
}

/// True for refs that point at a file next to the document rather than at
/// the network or an already-inlined payload.
export function isLocalRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function toDataUrl(filePath: string): string {
  const mimeType = MIME_BY_EXTENSION[extensionOf(filePath)] ?? 'application/octet-stream';
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}
