import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Project } from '@shared/types';

/// The files pill in the corner of the welcome screen: how many documents are
/// in this project, and the way into them.
///
/// Deliberately small. Earlier versions of this put the file list itself on
/// the welcome screen, which turned the page's one question ("what do you
/// want to do?") into the fourth item on a list. A count and a door is the
/// whole job — the documents view is where browsing actually happens.

export function ProjectFilesBubble({
  project,
  /// Everyday projects open the documents grid and count what is in the
  /// folder; a repo or a workspace opens the explorer it already has, and
  /// counting a source tree would say nothing useful.
  variant = 'documents',
}: {
  project: Project;
  variant?: 'documents' | 'files';
}) {
  const openExplorer = useStore((s) => s.openExplorer);
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (variant !== 'documents') return;
    const res = await window.overcli.invoke('fs:listDocuments', { dirPath: project.path });
    setCount(res.ok ? res.entries.length : null);
  }, [project.path, variant]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A brand-new project has one file (its brief) and nothing the user put
  // there, so "1 document" would be a strange first thing to be told. Invite
  // instead of counting until there is something of theirs to count.
  //
  // And a verb either way. "4 documents" names a thing and leaves the reader
  // to work out that it is a door; the count is not what makes anyone click,
  // and it is visible the instant they do.
  const label =
    variant === 'files'
      ? 'Browse files'
      : count === null || count <= 1
        ? 'Add your documents'
        : 'Your documents';

  return (
    <button
      onClick={() => openExplorer(project.path)}
      title={variant === 'files' ? 'Open the file explorer' : 'Open your documents'}
      className="flex items-center gap-2 rounded-full border border-card bg-surface-elevated pl-2.5 pr-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:border-card-strong hover:bg-card-strong transition-colors"
      style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
    >
      <span
        className="w-5 h-5 rounded flex items-center justify-center shrink-0"
        style={{
          background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)',
          color: 'var(--c-accent)',
        }}
      >
        <FolderGlyph />
      </span>
      {label}
      <span className="text-ink-faint">›</span>
    </button>
  );
}

function FolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v6.21a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}
