import fs from 'node:fs';
import path from 'node:path';
import type { DocumentEntry } from '../shared/types';
import { DOCUMENT_TYPES } from '../shared/everydayProjects';
import { tierDefault } from '../shared/modelCatalog';
import { pickDrafterBackend } from '../shared/flows/drafterBackend';
import { healthyBackends } from './health';
import { listFileEntriesSync } from './fileWalk';
import { oneShotDraftText, type DraftDeps } from './flows/drafter';

/// The file surface behind the documents view — a Drive-style listing of one
/// folder at a time, and "describe it and get one written".
///
/// Deliberately not `fileWalk`: that recurses the whole project and returns
/// paths for a code tree. A person browsing their documents opens one folder,
/// sees what is in it, and goes in — so this lists a single level, keeps
/// folders, and carries the modified time that a file card shows.

/// Noise a non-engineer never wants to see in their own folder. `.git` is the
/// undo history we put there ourselves; showing it would undo the entire
/// point of never saying "git" to this user.
const HIDDEN = new Set(['.git', '.DS_Store', 'node_modules', '.gitignore']);

export function listDocuments(
  args: { dirPath: string },
): { ok: true; entries: DocumentEntry[] } | { ok: false; error: string } {
  try {
    const dirents = fs.readdirSync(args.dirPath, { withFileTypes: true });
    const entries: DocumentEntry[] = [];
    for (const d of dirents) {
      if (HIDDEN.has(d.name) || d.name.startsWith('.')) continue;
      const full = path.join(args.dirPath, d.name);
      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.statSync(full);
        sizeBytes = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        // A file that vanished between readdir and stat still lists, with
        // zeroes, rather than collapsing the whole folder into an error.
      }
      entries.push({ name: d.name, path: full, isDir: d.isDirectory(), sizeBytes, mtimeMs });
    }
    // Folders first, then newest work first — the thing you were just doing
    // is the thing you most likely want next.
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.mtimeMs - a.mtimeMs;
    });
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// Extensions the model is allowed to choose. Everything here is something
/// the editor can open and the user can read back — no binaries, and nothing
/// that would need an app they may not have.
const ALLOWED_EXTS = ['md', 'txt', 'csv', 'json', 'html'] as const;

function buildSystemPrompt(): string {
  return [
    'You write a single document for a non-technical person — a business',
    'professional or a student. They described what they want in plain words.',
    '',
    'Reply with EXACTLY this shape and nothing else:',
    '',
    'FILENAME: <name with extension>',
    '---',
    '<the full document>',
    '',
    'Rules:',
    `  - The extension must be one of: ${ALLOWED_EXTS.join(', ')}. Default to .md.`,
    '  - Use .csv only when the request is genuinely tabular.',
    '  - The filename must be plain words a person would recognise in a folder',
    '    ("Q3 marketing plan.md"), not a slug ("q3-marketing-plan.md").',
    '  - Write the whole document, finished and usable. No placeholders, no',
    '    "TODO", no meta-commentary about what you produced.',
    '  - Do not wrap the document in a code fence.',
    '  - Markdown documents start with a single `# Title` line.',
  ].join('\n');
}

/// Split the model's reply into a filename and a body. Falls back to a
/// derived name rather than failing the whole request: the user asked for a
/// document, and a correct document under a dull name still beats an error.
export function parseDraftedDocument(
  raw: string,
  fallbackName: string,
): { name: string; body: string } {
  const match = raw.match(/^\s*FILENAME:\s*(.+?)\s*\r?\n-{3,}\r?\n([\s\S]*)$/);
  const rawName = match ? match[1] : fallbackName;
  const body = match ? match[2] : raw;
  return { name: safeDocumentName(rawName, fallbackName), body: body.trim() + '\n' };
}

/// Model output reaches the filesystem here, so the name is rebuilt rather
/// than trusted: basename only, no path separators, and an extension from the
/// allow-list.
export function safeDocumentName(candidate: string, fallbackName: string): string {
  const base = path.basename(String(candidate ?? '').trim()).replace(/^\.+/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `${fallbackName}.md`;
  const ext = path.extname(cleaned).slice(1).toLowerCase();
  // Truncate the STEM, never the whole name: slicing `cleaned` could cut
  // through the extension and write an extension-less document.
  if ((ALLOWED_EXTS as readonly string[]).includes(ext)) {
    const stem = cleaned.slice(0, cleaned.length - ext.length - 1);
    return `${stem.slice(0, 80 - ext.length - 1) || fallbackName}.${ext}`;
  }
  return `${cleaned.replace(/\.[^.]*$/, '').slice(0, 76) || fallbackName}.md`;
}

/// `Q3 plan.md` twice gives `Q3 plan.md` and `Q3 plan 2.md`. Never an
/// overwrite — the previous one may be the document they actually wanted.
export function uniqueDocumentPath(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/// An empty file, named and typed by the user. Separate from the drafted
/// path because "I know what I want to write" should not cost an LLM call or
/// the wait that comes with it.
export function createBlankDocument(
  args: { dirPath: string; name: string; ext: string },
): { ok: true; path: string } | { ok: false; error: string } {
  const typed = DOCUMENT_TYPES.find((t) => t.ext === args.ext) ?? DOCUMENT_TYPES[0];
  const stem = String(args.name ?? '').trim() || 'Untitled';
  const name = safeDocumentName(`${stem}.${typed.ext}`, 'Untitled');
  try {
    fs.mkdirSync(args.dirPath, { recursive: true });
    const target = uniqueDocumentPath(args.dirPath, name);
    // A markdown file opens with its own title already in it — an editor
    // showing a totally blank page is a worse starting point than one that
    // shows you what you just named.
    const seed = typed.ext === 'md' ? `# ${stem}\n\n` : '';
    fs.writeFileSync(target, seed, 'utf-8');
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function createDocumentFromPrompt(
  deps: DraftDeps,
  args: { dirPath: string; description: string },
): Promise<{ ok: true; path: string; backend: string } | { ok: false; error: string }> {
  const description = args.description.trim();
  if (!description) return { ok: false, error: 'Say what you want the document to be.' };

  const out = await oneShotDraftText(deps, {
    buildSystemPrompt: () => buildSystemPrompt(),
    userMessage: description,
    verb: 'write a document',
  });
  if (!out.ok) return out;

  const { name, body } = parseDraftedDocument(out.text, 'New document');
  try {
    fs.mkdirSync(args.dirPath, { recursive: true });
    const target = uniqueDocumentPath(args.dirPath, name);
    fs.writeFileSync(target, body, 'utf-8');
    return { ok: true, path: target, backend: out.label };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/// Editing a document is a small, mechanical ask — "make this shorter",
/// "fix the tone", "add a section on pricing". It wants the fast tier and
/// the latency that comes with it, not the model that designs flows.
const MAX_REVISE_CHARS = 60_000;

/// Total budget for the OTHER documents handed to a rewrite as context.
/// The one-shot transport runs with tools disabled (see `draftViaClaudeSdk`),
/// so a model asked to "add the course material to the brief" cannot go and
/// read it — it only knows what we put in the prompt. This is that.
const MAX_CONTEXT_CHARS = 40_000;

/// Extensions worth reading as context. Everything else in the folder is
/// either binary or something the model cannot use as prose.
const CONTEXT_EXTS = new Set(['md', 'txt', 'csv', 'json', 'html', 'tsv']);

/// The project's other documents, nearest first, up to the budget. Nearest
/// because a file beside the one being edited is likelier to be what "the
/// course material" refers to than something four folders down.
export function gatherProjectContext(
  args: { rootPath: string; excludePath: string },
): { blocks: Array<{ rel: string; text: string }>; omitted: string[] } {
  const here = path.dirname(args.excludePath);
  const candidates = listFileEntriesSync(args.rootPath)
    .filter((e) => e.path !== args.excludePath)
    .filter((e) => CONTEXT_EXTS.has(path.extname(e.path).slice(1).toLowerCase()))
    .sort((a, b) => {
      const depth = (p: string) => (path.dirname(p) === here ? 0 : 1);
      const byNearness = depth(a.path) - depth(b.path);
      return byNearness !== 0 ? byNearness : a.path.localeCompare(b.path);
    });

  const blocks: Array<{ rel: string; text: string }> = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const entry of candidates) {
    const rel = path.relative(args.rootPath, entry.path);
    if (spent + entry.sizeBytes > MAX_CONTEXT_CHARS) {
      omitted.push(rel);
      continue;
    }
    try {
      const text = fs.readFileSync(entry.path, 'utf-8');
      blocks.push({ rel, text });
      spent += text.length;
    } catch {
      omitted.push(rel);
    }
  }
  return { blocks, omitted };
}

export async function reviseDocument(
  deps: DraftDeps,
  args: {
    path: string;
    content: string;
    instruction: string;
    rootPath?: string;
    fullDocument?: string;
    /// Doubles as the cancel handle: the renderer already has a requestId for
    /// correlating progress events, so it can stop the turn with the same id.
    requestId?: string;
  },
  onProgress?: (text: string) => void,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const instruction = args.instruction.trim();
  if (!instruction) return { ok: false, error: 'Say what you want changed.' };
  if (args.content.length + (args.fullDocument?.length ?? 0) > MAX_REVISE_CHARS) {
    return {
      ok: false,
      error:
        'This document is too long to edit in one go. Select the part you want changed and ask again.',
    };
  }

  // Resolve the fast model for whichever CLI the user is signed in to, and
  // let `oneShotDraftText` fall back to its own default if that backend has
  // no fast tier.
  const healthy = await healthyBackends(deps.settings.backendPaths);
  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) => healthy.has(b),
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  const fastModel =
    backend && backend !== 'ollama'
      ? tierDefault(backend, 'fast', deps.settings.flowModelDefaults)
      : undefined;

  const out = await oneShotDraftText(deps, {
    model: fastModel,
    onProgress,
    cancelKey: args.requestId,
    buildSystemPrompt: () => [
      'You revise one document for a non-technical person.',
      '',
      'You are given the document and an instruction. Reply with the COMPLETE',
      'revised document and nothing else — no preamble, no explanation, no',
      'code fence, no "here is the updated version".',
      '',
      'Rules:',
      '  - Change only what the instruction asks for. Leave the rest byte-identical.',
      '  - Keep the existing format (markdown stays markdown, CSV stays CSV).',
      '  - Never shorten the document by dropping content you were not asked to remove.',
      '  - If the instruction cannot be applied, reply with the document unchanged.',
      '',
      'If you are given a SELECTED PASSAGE, rewrite ONLY that passage and reply',
      'with the passage alone — no surrounding document, no explanation. The',
      'rest of the file is shown to you so your rewrite fits where it lands.',
      '',
      'You may be given OTHER DOCUMENTS from the same project. They are context',
      'only — never edit them, and only draw on them when the instruction asks',
      'you to (e.g. "summarise the course material into this brief").',
    ].join('\n'),
    userMessage: buildReviseMessage(args, instruction),
    verb: 'edit a document',
  });
  if (!out.ok) return out;

  // Models still occasionally fence the whole reply despite being told not
  // to; strip one wrapping fence rather than writing backticks into the
  // user's document.
  const text = out.text.replace(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/, '$1');
  if (!text.trim()) return { ok: false, error: 'The model returned an empty document.' };
  return { ok: true, content: text };
}

function buildReviseMessage(
  args: { path: string; content: string; rootPath?: string; fullDocument?: string },
  instruction: string,
): string {
  const parts = [`INSTRUCTION:\n${instruction}`];
  if (args.fullDocument) {
    parts.push(
      `THE WHOLE DOCUMENT (context only — you are rewriting one passage of it):\n${args.fullDocument}`,
    );
  }
  if (args.rootPath) {
    const { blocks, omitted } = gatherProjectContext({
      rootPath: args.rootPath,
      excludePath: args.path,
    });
    if (blocks.length) {
      parts.push(
        'OTHER DOCUMENTS IN THIS PROJECT (context only — do not edit these):\n' +
          blocks.map((b) => `--- ${b.rel} ---\n${b.text}`).join('\n\n'),
      );
    }
    if (omitted.length) {
      parts.push(
        `NOTE: these were too large to include, so you have not seen them: ${omitted.join(', ')}.`,
      );
    }
  }
  parts.push(
    args.fullDocument
      ? `SELECTED PASSAGE TO REWRITE (from ${path.basename(args.path)}):\n${args.content}`
      : `DOCUMENT TO REWRITE (${path.basename(args.path)}):\n${args.content}`,
  );
  return parts.join('\n\n');
}
