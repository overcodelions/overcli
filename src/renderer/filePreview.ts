export type FileViewMode = 'edit' | 'preview' | 'diff';

export type FilePreviewKind =
  | 'html'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'csv'
  | 'json'
  | 'office'
  | 'react';

const HTML_EXTENSIONS = new Set(['html', 'htm']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const CSV_EXTENSIONS = new Set(['csv', 'tsv']);
const JSON_EXTENSIONS = new Set(['json', 'jsonc']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const REACT_EXTENSIONS = new Set(['tsx', 'jsx']);
const BINARY_PREVIEW_KINDS = new Set<FilePreviewKind>(['image', 'pdf', 'office']);
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  '7z',
  'a',
  'app',
  'avi',
  'bin',
  'bz2',
  'class',
  'dmg',
  'dll',
  'dylib',
  'eot',
  'exe',
  'gz',
  'icns',
  'jar',
  'mov',
  'mp3',
  'mp4',
  'o',
  'otf',
  'pkg',
  'rar',
  'so',
  'sqlite',
  'sqlite3',
  'tar',
  'tgz',
  'ttf',
  'war',
  'wasm',
  'woff',
  'woff2',
  'xz',
  'zip',
]);

export function detectFilePreviewKind(filePath: string | null | undefined): FilePreviewKind | null {
  if (!filePath) return null;
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (CSV_EXTENSIONS.has(ext)) return 'csv';
  if (JSON_EXTENSIONS.has(ext)) return 'json';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (REACT_EXTENSIONS.has(ext)) return 'react';
  return null;
}

export function canPreviewFile(filePath: string | null | undefined): boolean {
  return detectFilePreviewKind(filePath) !== null;
}

export function isBinaryPreviewKind(kind: FilePreviewKind | null): boolean {
  return kind != null && BINARY_PREVIEW_KINDS.has(kind);
}

export function isUnsupportedBinaryFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  return UNSUPPORTED_BINARY_EXTENSIONS.has(ext);
}

export function defaultFileViewMode(
  filePath: string,
  hasHighlight: boolean,
  requestedMode?: FileViewMode,
): FileViewMode {
  if (requestedMode === 'preview' && !canPreviewFile(filePath)) return 'edit';
  if (requestedMode) return requestedMode;
  return !hasHighlight && canPreviewFile(filePath) ? 'preview' : 'edit';
}
