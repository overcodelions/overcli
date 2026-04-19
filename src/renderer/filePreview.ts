export type FileViewMode = 'edit' | 'preview' | 'diff';

export type FilePreviewKind = 'html' | 'markdown';

const HTML_EXTENSIONS = new Set(['html', 'htm']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function detectFilePreviewKind(filePath: string | null | undefined): FilePreviewKind | null {
  if (!filePath) return null;
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  return null;
}

export function canPreviewFile(filePath: string | null | undefined): boolean {
  return detectFilePreviewKind(filePath) !== null;
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
