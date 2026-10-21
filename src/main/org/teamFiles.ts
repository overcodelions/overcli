// A team task's shared folder, as the console's Files tab sees it: what is
// in it, and where each file can be kept — the Library, or a Drive or
// SharePoint the org has a tool installed for.

import fs from 'node:fs';
import path from 'node:path';

export interface FolderFile {
  /// Path relative to the task folder, `/`-separated.
  name: string;
  size: number;
  modifiedAt: number;
}

const MAX_FILES = 2000;

/// Every file under `root`, skipping dotfiles and dot folders, and anything
/// that is a link (it could point out of the folder). Newest first.
export function listFolder(root: string): FolderFile[] {
  const out: FolderFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, name, depth + 1);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          out.push({ name, size: st.size, modifiedAt: Math.round(st.mtimeMs) });
        } catch {
          // gone between the listing and the stat
        }
      }
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(root, '', 0);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

/// A file in the folder by its relative name, or null: refuses names that
/// climb out, hidden parts, and links that resolve elsewhere.
export function readInFolder(root: string, name: string): Buffer | null {
  if (!name || name.includes('\0') || path.isAbsolute(name)) return null;
  if (name.split(/[\\/]/).some((p) => p.startsWith('.'))) return null;
  try {
    const base = fs.realpathSync(root);
    const target = path.resolve(base, name);
    if (!target.startsWith(base + path.sep)) return null;
    const real = fs.realpathSync(target);
    if (!real.startsWith(base + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return fs.readFileSync(real);
  } catch {
    return null;
  }
}

/// Bytes that read as text: no NUL in the first 8 KB and valid-ish UTF-8.
export function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

export function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  return 'text/plain';
}

/// The Library's title for a kept file: its first markdown heading, else its name.
export function fileTitle(name: string, text: string): string {
  if (/\.(md|markdown)$/i.test(name)) {
    const h = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
    if (h) return h[1].trim().slice(0, 160);
  }
  return name.split('/').pop() || name;
}

/// A download name from a task title: `roadmap-ranking.zip`.
export function slugFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'team-task';
}

export type DestinationKind = 'library' | 'drive' | 'sharepoint' | 'other';

/// Which kind of store an installed MCP server is, by its name or its tools.
/// Microsoft first: "onedrive" would otherwise read as a Drive.
export function classifyServer(name: string, tools: readonly string[] = []): 'drive' | 'sharepoint' | null {
  const ms = /sharepoint|onedrive|graph|microsoft|teams/i;
  const google = /drive|gdrive|google/i;
  if (ms.test(name)) return 'sharepoint';
  if (google.test(name)) return 'drive';
  if (tools.some((t) => ms.test(t))) return 'sharepoint';
  if (tools.some((t) => google.test(t))) return 'drive';
  return null;
}

/// The tool that puts a file there: an upload first, then a create or write.
export function pickUploadTool<T extends { name: string }>(tools: readonly T[]): T | null {
  const order = [/upload/i, /create.*file/i, /write.*file/i, /put/i];
  for (const re of order) {
    const hit = tools.find((t) => re.test(t.name));
    if (hit) return hit;
  }
  return null;
}

interface JsonSchema {
  properties?: Record<string, { type?: unknown } | undefined>;
  required?: unknown;
}

/// Best-effort arguments for an upload tool, from its input schema: the file
/// name into a name/title property, the text into content/text/body/data,
/// a mime type when it asks for one. Required properties left over are
/// returned as `missing`, for an error that names them.
export function uploadArgs(schema: unknown, name: string, text: string): { args: Record<string, unknown>; missing: string[] } {
  const s = (schema && typeof schema === 'object' ? schema : {}) as JsonSchema;
  const props = s.properties && typeof s.properties === 'object' ? Object.keys(s.properties) : [];
  const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : [];
  const args: Record<string, unknown> = {};
  const base = name.split('/').pop() || name;
  for (const p of props) {
    const k = p.toLowerCase().replace(/[-_]/g, '');
    if (['name', 'title', 'filename'].includes(k)) args[p] = base;
    // A path it insists on: the file's name, at the top of where it saves.
    else if ((k === 'path' || k === 'filepath') && required.includes(p)) args[p] = base;
    else if (['content', 'contents', 'text', 'body', 'data', 'filecontent', 'filecontents', 'markdown'].includes(k)) args[p] = text;
    else if (k === 'mimetype' || k === 'contenttype') args[p] = mimeFor(name);
  }
  // A schema that names nothing: the common shape.
  if (!props.length) {
    args.name = base;
    args.content = text;
  }
  const missing = required.filter((r) => !(r in args));
  return { args, missing };
}

/// A link to what the tool made, if its answer carries one.
export function linkFrom(call: { text: string; json: unknown }): string | undefined {
  const re = /https?:\/\/[^\s<>)"'\]]+/;
  const fromText = re.exec(call.text ?? '')?.[0];
  if (fromText) return fromText;
  if (call.json !== null && call.json !== undefined) {
    try {
      return re.exec(JSON.stringify(call.json))?.[0];
    } catch {
      return undefined;
    }
  }
  return undefined;
}
