/// `split` is edit + live preview side by side. It only makes sense for the
/// previewable text formats (markdown, html), which is why the button is
/// gated on `canPreviewFile` rather than offered everywhere.
export type FileViewMode = 'edit' | 'preview' | 'diff' | 'split';

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

/// The extension a remembered view mode is keyed by, or '' for a file that
/// has none. Per-extension rather than per-file: the point is that having
/// previewed one README you get the next one rendered too.
export function fileExtensionKey(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return name.includes('.') ? name.split('.').pop() ?? '' : '';
}

/// Types that open rendered. Markdown and React components are the two you
/// read far more often than you edit — a doc is written once and consulted
/// repeatedly, and a component is judged by how it looks. Every other
/// previewable type (html, csv, json, images) still opens as source, because
/// for those the text is usually the point.
const RENDER_FIRST_KINDS = new Set<FilePreviewKind>(['markdown', 'react']);

export function rendersByDefault(filePath: string | null | undefined): boolean {
  const kind = detectFilePreviewKind(filePath);
  return kind != null && RENDER_FIRST_KINDS.has(kind);
}

/// Which mode a newly opened tab lands in, in precedence order.
///
/// A caller that names a mode always wins. After that, a `path:line` jump
/// forces the editor, because Preview cannot show you line 42. Then the
/// remembered mode for this extension, if you have set one. Otherwise markdown
/// and React components render and everything else opens as source.
///
/// History worth knowing: previewable types defaulted to Preview originally,
/// which #126 changed to always-File on the grounds that you usually want the
/// source and that a mixed tab strip is confusing. That went too far for the
/// two types people genuinely read more than they edit, so those come back —
/// but the remembered mode means one click still switches it back for good,
/// which is what the old all-or-nothing default lacked.
export function defaultFileViewMode(
  filePath: string,
  hasHighlight: boolean,
  requestedMode?: FileViewMode,
  rememberedMode?: FileViewMode,
  /// Everyday projects open a document in `split` — rendered on the right,
  /// editable on the left. A code project keeps `preview`, where reading a
  /// rendered README is usually the whole intent; someone whose project IS
  /// documents is there to write, and preview alone makes the file look
  /// read-only.
  preferSplit?: boolean,
): FileViewMode {
  if (requestedMode === 'preview' && !canPreviewFile(filePath)) return 'edit';
  if (requestedMode) return requestedMode;
  // An image, a PDF or a Word file has no source to fall back to: `edit`
  // renders a "not editable as text" dead end with the thing the user asked
  // for one click away. So these open rendered whatever the other signals
  // say — a `path:line` highlight means nothing on a PNG, and a remembered
  // `edit`/`split` for the extension was recorded by a click that landed on
  // that same dead end. Only a remembered `diff` survives, because reviewing
  // a changed binary is a real thing to want.
  if (isBinaryPreviewKind(detectFilePreviewKind(filePath))) {
    return rememberedMode === 'diff' ? 'diff' : 'preview';
  }
  if (hasHighlight) return 'edit';
  if (rememberedMode) {
    // 'split' is as much a rendering mode as 'preview' — collapsing it to
    // 'edit' meant choosing Split once turned it off for good.
    if ((rememberedMode === 'preview' || rememberedMode === 'split') && canPreviewFile(filePath)) {
      return rememberedMode;
    }
    return rememberedMode === 'preview' || rememberedMode === 'split' ? 'edit' : rememberedMode;
  }
  if (!rendersByDefault(filePath)) return 'edit';
  // `rendersByDefault` covers markdown and HTML — both editable, so split is
  // always meaningful here. Binary artifacts never reach this branch.
  return preferSplit ? 'split' : 'preview';
}
