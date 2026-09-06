import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { Diff } from './DiffView';
import { versionTimestamp } from './sheets/VersionsSheet';
import type { ProjectVersion } from '@shared/types';

/// One document's history, beside the document.
///
/// The versions sheet answers "what happened to this folder"; this answers
/// "what happened to THIS", which is the question you have while reading
/// something and finding it wrong. Reaching the sheet meant leaving the
/// document, scanning a list of folder-wide versions for the ones that
/// mentioned it, and deciding from a subject line.
///
/// Every entry here already touched this file — versions that didn't are not
/// this document's history — and "Put it back" restores THIS document only.
/// The folder-wide restore is still a click away in the sheet, and is named
/// differently on purpose: reverting everything is a much larger act than
/// reverting the thing you are looking at.

/// How many of this document's versions to offer. Deep history is the sheet's
/// job; the rail is for the recent past you can still remember.
const RAIL_VERSION_LIMIT = 12;

/// Repo-relative, forward slashes — the form `git log --name-status` reports
/// and therefore the form `ProjectVersionFile.path` carries.
function relativeTo(rootPath: string, filePath: string): string | null {
  const root = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  if (!filePath.startsWith(root)) return null;
  return filePath.slice(root.length);
}

export function DocumentVersionsRail({
  rootPath,
  filePath,
}: {
  rootPath: string;
  filePath: string;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const noteVersionsRestored = useStore((s) => s.noteVersionsRestored);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const rel = relativeTo(rootPath, filePath);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);

  const load = useCallback(async () => {
    const res = await window.overcli.invoke('versions:list', { projectPath: rootPath });
    if (!res.ok) {
      setVersions([]);
      setError(res.error);
      return;
    }
    setError(null);
    // A version that never touched this document is not this document's
    // history, however recent it is.
    setVersions(
      res.versions.filter((v) => v.files.some((f) => f.path === rel)).slice(0, RAIL_VERSION_LIMIT),
    );
  }, [rootPath, rel]);

  useEffect(() => {
    setOpenSha(null);
    setDiff(null);
    setConfirming(null);
    if (rel) void load();
  }, [load, rel]);

  const show = async (sha: string) => {
    if (openSha === sha) {
      setOpenSha(null);
      return;
    }
    setOpenSha(sha);
    setDiff(null);
    const res = await window.overcli.invoke('versions:diff', { projectPath: rootPath, sha, file: rel ?? undefined });
    setDiff(res.ok ? res.diff : `Couldn't read that change.\n${res.error}`);
  };

  const restore = async (version: ProjectVersion) => {
    setBusy(version.sha);
    setError(null);
    const res = await window.overcli.invoke('versions:restoreFile', {
      projectPath: rootPath,
      sha: version.sha,
      filePath,
      label: `${name} — ${versionTimestamp(version.at, new Date()) || version.subject}`,
    });
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpenSha(null);
    noteVersionsRestored(rootPath);
    void load();
  };

  const now = new Date();

  return (
    <div className="w-[318px] shrink-0 border-l border-card flex flex-col min-h-0">
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-card flex flex-col gap-1">
        <div className="text-[13px] font-semibold text-ink">Earlier versions</div>
        <div className="text-[11px] text-ink-faint leading-relaxed">
          A version is saved whenever something finishes. Putting one back makes a new version
          too, so you can always come forward again.
        </div>
      </div>

      {error && <div className="shrink-0 px-4 py-2 text-[11px] text-red-400">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        {versions.length === 0 && !error ? (
          <div className="text-[11px] text-ink-faint px-1 leading-relaxed">
            {rel
              ? 'Nothing has changed this document since it arrived.'
              : 'This document is outside the project folder, so it has no history here.'}
          </div>
        ) : (
          versions.map((v, i) => {
            const open = openSha === v.sha;
            const mine = v.files.find((f) => f.path === rel);
            return (
              <div
                key={v.sha}
                className={
                  'rounded-lg border px-3 py-2.5 flex flex-col gap-1.5 ' +
                  (open ? 'accent-invite' : 'border-card bg-card')
                }
              >
                <button
                  onClick={() => void show(v.sha)}
                  className="flex items-center gap-2 text-left"
                >
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="text-xs text-ink truncate">{versionTimestamp(v.at, now)}</div>
                    <div className="text-[11px] text-ink-faint truncate">{v.subject}</div>
                  </div>
                  {/* The newest version this document has is what you are
                      reading — labelling it says so, and saves offering to
                      restore the file to its current contents. */}
                  {i === 0 ? (
                    <span className="shrink-0 rounded-full border border-accent/45 px-2 text-[10px] text-accent">
                      Now
                    </span>
                  ) : (
                    mine &&
                    !mine.binary && (
                      <span className="shrink-0 text-[10px] tabular-nums">
                        <span className="diff-add-ink">+{mine.additions}</span>{' '}
                        <span className="diff-remove-ink">−{mine.deletions}</span>
                      </span>
                    )
                  )}
                </button>

                {open && (
                  <div className="flex flex-col gap-2 pt-2 border-t border-card">
                    <div className="max-h-[220px] overflow-auto rounded border border-card">
                      {diff === null ? (
                        <div className="px-2 py-1.5 text-[11px] text-ink-faint">Reading…</div>
                      ) : (
                        <Diff unifiedDiff={diff} compact />
                      )}
                    </div>
                    {i > 0 &&
                      (confirming === v.sha ? (
                        <div className="flex flex-col gap-1.5">
                          <div className="text-[11px] text-ink-muted leading-relaxed">
                            Put <span className="text-ink">{name}</span> back to this version?
                            Nothing else in the folder changes.
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => setConfirming(null)}
                              className="flex-1 rounded border border-card px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void restore(v)}
                              disabled={busy === v.sha}
                              className="flex-1 accent-soft rounded border px-2 py-1 text-[11px] text-accent disabled:opacity-40"
                            >
                              {busy === v.sha ? 'Putting back…' : 'Put it back'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirming(v.sha)}
                          className="rounded border border-card-strong px-2 py-1 text-[11px] text-ink-muted hover:text-ink hover:bg-card-strong"
                        >
                          Put it back
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* The folder-wide restore, named as the larger thing it is. */}
      <div className="shrink-0 border-t border-card px-3 py-2.5">
        <button
          onClick={() => openSheet({ type: 'versions', projectPath: rootPath })}
          className="w-full rounded border border-card px-2 py-1.5 text-[11px] text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          The whole folder's history
        </button>
      </div>
    </div>
  );
}
