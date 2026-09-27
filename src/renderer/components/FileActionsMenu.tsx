// What you can do with a file from wherever it is shown: copy its path, open
// it in another app, show it in its folder, save a copy. Shared by the file
// editor's header and the Today reader, so the same file offers the same
// actions whichever pane you meet it in.

import { useEffect, useState, type RefObject } from 'react';

import { detectFilePreviewKind } from '../filePreview';
import { revealLabel } from '../platform';

/// Which browser "Open in browser" will use, probed once per app session —
/// the answer is an `existsSync` in main and cannot change while the app runs.
/// Cached as the promise, so several menus opening at once share one call.
let browserNamePromise: Promise<string | null> | null = null;
function browserName(): Promise<string | null> {
  browserNamePromise ??= window.overcli
    .invoke('fs:browserName')
    .then((r) => r?.name ?? null)
    .catch(() => null);
  return browserNamePromise;
}

/// Closes a menu on an outside click or Escape.
export function useMenuDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

/// The rows every file menu has. Rendered only while the menu is open, so the
/// browser probe below runs the first time a page's menu opens, not on mount
/// of the pane — most files are not HTML and never need the answer.
export function FileActionItems({
  path,
  missing,
  close,
  beforeDownload,
  onError,
}: {
  path: string;
  /// The file is gone from disk — only Copy path still means anything.
  missing?: boolean;
  close: () => void;
  /// The editor saves unsaved edits first, so the copy is what you see.
  beforeDownload?: () => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [copiedPath, setCopiedPath] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [browser, setBrowser] = useState<string | null>(null);
  const isHtml = detectFilePreviewKind(path) === 'html';

  useEffect(() => {
    if (!isHtml || missing) return;
    let live = true;
    void browserName().then((name) => {
      if (live) setBrowser(name);
    });
    return () => {
      live = false;
    };
  }, [isHtml, missing]);

  return (
    <>
      <FileMenuItem
        label={copiedPath ? 'Copied' : 'Copy path'}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopiedPath(true);
            // Held open so the confirmation is actually seen — closing on
            // click would flash it for one frame.
            window.setTimeout(() => {
              setCopiedPath(false);
              close();
            }, 900);
          } catch {
            setCopiedPath(false);
            close();
          }
        }}
      />
      {!missing && isHtml && browser && (
        // A page's own reason for existing is being rendered, and "default
        // app" is a coin flip that lands on an editor whenever one has
        // registered for .html. Named after the browser we actually found, so
        // the row can't mislead.
        <FileMenuItem
          label={`Open in ${browser}`}
          onClick={async () => {
            close();
            const res = await window.overcli.invoke('fs:openInBrowser', path);
            if (!res.ok) onError?.(res.error);
          }}
        />
      )}
      {!missing && (
        // No "e.g. VS Code" hint: which app this opens is the system's
        // business and we would only be guessing.
        <FileMenuItem
          label="Open in default app"
          onClick={async () => {
            close();
            const res = await window.overcli.invoke('fs:openPath', path);
            if (!res.ok) onError?.(res.error);
          }}
        />
      )}
      {!missing && (
        // Where every real share starts — drag into Slack, AirDrop, attach to
        // mail. `revealLabel()` because the OS supplies the noun (Finder,
        // Explorer, folder); the IPC behind it is already cross-platform.
        <FileMenuItem
          label={revealLabel()}
          onClick={() => {
            close();
            void window.overcli.invoke('fs:openInFinder', path);
          }}
        />
      )}
      {!missing && (
        <FileMenuItem
          label={
            downloadState === 'saved'
              ? 'Saved to Downloads'
              : downloadState === 'failed'
                ? "Couldn't save it"
                : 'Download a copy'
          }
          onClick={async () => {
            if (beforeDownload) await beforeDownload();
            const res = await window.overcli.invoke('fs:saveToDownloads', path);
            setDownloadState(res.ok ? 'saved' : 'failed');
            window.setTimeout(
              () => {
                setDownloadState('idle');
                close();
              },
              res.ok ? 1600 : 2400,
            );
          }}
        />
      )}
    </>
  );
}

/// One row of a file menu. Rows rather than buttons because the hint sits
/// under the label — "Revert to HEAD" has room to say what it does here in a
/// way a 62px button in a bar never did.
export function FileMenuItem({
  label,
  hint,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={
        'w-full text-left px-2.5 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed ' +
        (danger
          ? 'text-red-600 dark:text-red-300 hover:bg-red-500/10'
          : 'text-ink hover:bg-card-strong')
      }
    >
      <span className="block truncate">{label}</span>
      {hint && <span className="block truncate text-[10px] text-ink-faint">{hint}</span>}
    </button>
  );
}
