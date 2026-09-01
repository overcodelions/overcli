// Turning dropped/picked `File`s into `Attachment`s, in one place.
//
// This started life inside the Composer, which was the only surface that
// took files. It isn't any more: the worker hire screen and the worker AI
// edit box both send attachments alongside a drafting turn, and a second
// copy of "which extensions do we accept" would have drifted from the first
// the moment either changed.

import type { Attachment } from '@shared/types';
import {
  MAX_LLM_ATTACHMENT_BYTES,
  MAX_PROJECT_FILE_BYTES,
  tooLargeReason,
} from '@shared/fileLimits';

export { MAX_LLM_ATTACHMENT_BYTES, MAX_PROJECT_FILE_BYTES };

/// Non-image MIME prefixes / extensions we accept and forward to the
/// backend by writing to disk + inlining the path. Anything else gets
/// rejected with a message so the user understands why.
const TEXT_LIKE_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml',
  'log', 'ini', 'env', 'conf', 'sql',
]);

const DOCUMENT_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
]);

/// The `accept` attribute for a file input that mirrors `isAcceptedAttachment`.
export const ATTACHMENT_ACCEPT = [
  'image/*',
  'text/*',
  'application/json',
  'application/xml',
  'application/x-yaml',
  ...DOCUMENT_MIMES,
  ...[...TEXT_LIKE_EXTS, ...DOCUMENT_EXTS].map((e) => `.${e}`),
].join(',');

export function guessMimeFromName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'csv': return 'text/csv';
    case 'tsv': return 'text/tab-separated-values';
    case 'json': return 'application/json';
    case 'yaml':
    case 'yml': return 'application/x-yaml';
    case 'xml': return 'application/xml';
    case 'md': return 'text/markdown';
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls': return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt': return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'odt': return 'application/vnd.oasis.opendocument.text';
    case 'ods': return 'application/vnd.oasis.opendocument.spreadsheet';
    case 'odp': return 'application/vnd.oasis.opendocument.presentation';
    case 'rtf': return 'application/rtf';
    case 'log':
    case 'txt':
    case 'ini':
    case 'env':
    case 'conf':
    case 'toml':
    case 'sql':
    default:
      return 'text/plain';
  }
}

export function isAcceptedAttachment(f: File): boolean {
  if (f.type.startsWith('image/')) return true;
  if (f.type.startsWith('text/')) return true;
  if (f.type === 'application/json') return true;
  if (f.type === 'application/xml') return true;
  if (f.type === 'application/x-yaml') return true;
  if (DOCUMENT_MIMES.has(f.type)) return true;
  const dot = f.name.lastIndexOf('.');
  if (dot > 0) {
    const ext = f.name.slice(dot + 1).toLowerCase();
    if (TEXT_LIKE_EXTS.has(ext)) return true;
    if (DOCUMENT_EXTS.has(ext)) return true;
  }
  return false;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader.readAsDataURL returns `data:image/png;base64,xxx` — we
      // only want the raw base64 body, not the data-URL prefix, because
      // claude's wire format supplies media_type separately.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function attachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/// Read a picked/dropped file list into attachments. Unsupported and
/// oversized files are skipped with a reason rather than failing the batch —
/// dropping four files where one is a 40 MB video should still attach three.
export async function intakeAttachments(
  files: FileList | File[],
): Promise<{ attachments: Attachment[]; rejections: string[] }> {
  const attachments: Attachment[] = [];
  const rejections: string[] = [];
  for (const f of Array.from(files)) {
    if (!isAcceptedAttachment(f)) {
      rejections.push(
        `Skipped ${f.name || 'file'} — supported: images, text files (csv, json, md, log, …), and documents (pdf, docx, xlsx, pptx, …).`,
      );
      continue;
    }
    if (f.size > MAX_LLM_ATTACHMENT_BYTES) {
      rejections.push(tooLargeReason(f.name, f.size, MAX_LLM_ATTACHMENT_BYTES));
      continue;
    }
    let dataBase64: string;
    try {
      dataBase64 = await fileToBase64(f);
    } catch {
      rejections.push(`Couldn't read ${f.name || 'file'}.`);
      continue;
    }
    attachments.push({
      id: attachmentId(),
      mimeType: f.type || guessMimeFromName(f.name) || 'application/octet-stream',
      dataBase64,
      label: f.name,
      size: f.size,
    });
  }
  return { attachments, rejections };
}

/// Dropping a file INTO a project folder is a copy, not an LLM attachment:
/// `.pages`, `.numbers`, `.key` and anything else a Mac user owns belongs in
/// their own folder. Size is the only limit, and it is a laxer one.
///
/// Where the platform hands us the real path — every drag-and-drop, and file
/// picks on desktop — we pass the path through and let the main process copy
/// file to file. Reading a 50 MB deck into a base64 string here costs ~67 MB
/// of string plus another copy to clone it across IPC, for a file we only
/// ever wanted to move from one place on disk to another.
export interface ProjectFileIntake {
  name: string;
  size: number;
  /// The real path on disk, when we have it. Preferred over `dataBase64`.
  sourcePath?: string;
  /// The fallback for a `File` with no backing path — a pasted image, say.
  dataBase64?: string;
}

export async function intakeProjectFiles(
  files: FileList | File[],
): Promise<{ files: ProjectFileIntake[]; rejections: string[] }> {
  const intake: ProjectFileIntake[] = [];
  const rejections: string[] = [];
  for (const f of Array.from(files)) {
    if (f.size > MAX_PROJECT_FILE_BYTES) {
      rejections.push(tooLargeReason(f.name, f.size, MAX_PROJECT_FILE_BYTES));
      continue;
    }
    const sourcePath = pathForFile(f);
    if (sourcePath) {
      intake.push({ name: f.name || 'file', size: f.size, sourcePath });
      continue;
    }
    let dataBase64: string;
    try {
      dataBase64 = await fileToBase64(f);
    } catch {
      rejections.push(`Couldn't read ${f.name || 'file'}.`);
      continue;
    }
    intake.push({ name: f.name || 'file', size: f.size, dataBase64 });
  }
  return { files: intake, rejections };
}

/// Electron stopped exposing `File.path` in v32; `webUtils.getPathForFile` is
/// the supported replacement and the preload re-exports it. Absent in tests
/// and in a plain browser, where the base64 fallback takes over.
function pathForFile(f: File): string | null {
  try {
    return window.overcli?.filePath?.(f) || null;
  } catch {
    return null;
  }
}
