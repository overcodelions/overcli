/// One name for the managed folder everyday projects are scaffolded into,
/// shared by the main process (which creates it) and the renderer (which has
/// to recognise it without access to `os.homedir()`).

export const EVERYDAY_PROJECTS_DIRNAME = 'Overcli Projects';

/// Fallback recogniser for projects scaffolded before `Project.everyday`
/// existed. The flag is the real answer — this only catches folders that were
/// created by "New everyday project" in an earlier build and persisted
/// without it, so those users get the plain-language welcome too rather than
/// having to delete and recreate the project.
export function looksLikeEverydayProjectPath(projectPath: string): boolean {
  if (!projectPath) return false;
  return projectPath.split(/[\\/]/).includes(EVERYDAY_PROJECTS_DIRNAME);
}

/// The single answer to "is this an everyday project?".
///
/// Two signals, because neither alone is sufficient. `everyday` records
/// INTENT at creation and survives the folder being moved; the path check
/// catches projects scaffolded before that flag existed, and folders a user
/// drops into the managed directory themselves. Call sites used to pick one
/// or the other, so moving a project out of `~/Documents/Overcli Projects/`
/// kept the documents grid but silently lost auto-save.
export function isEverydayProject(project: { path: string; everyday?: boolean }): boolean {
  return project.everyday === true || looksLikeEverydayProjectPath(project.path);
}

/// Plain-word labels for the file types a blank document can be, so the
/// picker never makes a business user choose between "md" and "json".
/// Markdown is first because it is the default.
export const DOCUMENT_TYPES: ReadonlyArray<{ ext: string; label: string }> = [
  { ext: 'md', label: 'Document' },
  { ext: 'txt', label: 'Plain text' },
  { ext: 'csv', label: 'Spreadsheet' },
  { ext: 'html', label: 'Web page' },
  { ext: 'json', label: 'Data' },
];

/// Things a business user or student would call "a document". Deliberately
/// narrow: an agent asked for a slide deck may also write `build_deck.py`
/// and a shell script to regenerate it, and opening those on someone who
/// came here to review a marketing brief is worse than opening nothing.
const DOCUMENT_EXTS = new Set([
  'md', 'txt', 'rtf', 'csv', 'tsv', 'html',
  'doc', 'docx', 'odt',
  'xls', 'xlsx', 'ods',
  'ppt', 'pptx', 'odp',
  'pdf',
]);

export function isDocumentLikePath(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return DOCUMENT_EXTS.has(base.slice(dot + 1).toLowerCase());
}

/// Which of a version's files to put in front of the user. Prefers the one
/// they are most likely to have asked for: a real document over a preview
/// image, and the shallowest path when several qualify — an artifact nested
/// four folders down is usually scaffolding around the thing itself.
export function pickDocumentToShow(paths: readonly string[]): string | undefined {
  const docs = paths.filter(isDocumentLikePath);
  if (docs.length === 0) return undefined;
  const depth = (p: string) => p.split('/').length;
  return [...docs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
}

/// Prose files the ask-to-edit bar is offered on, in ANY project. Editing a
/// README or an ADR by describing the change is not an everyday-project
/// feature; it just happened to be built there first. Deliberately narrow to
/// markdown: a one-shot whole-file rewrite is right for prose and wrong for
/// source, which is what flows and agents are for.
export function isProseDocumentPath(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  return base.endsWith('.md') || base.endsWith('.markdown');
}
