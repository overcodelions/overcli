import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { Diff } from '../DiffView';
import type { ProjectVersion, ProjectVersionFile } from '@shared/types';

/// The version history of an everyday project, for someone who has never
/// heard of a commit.
///
/// A list of subjects is not enough to decide anything: "Claude worked on
/// the marketing brief" could be one line or a rewrite of sixteen files.
/// Every version opens into the files it touched, and every file opens into
/// the actual change — so "put it back" is a decision made on evidence
/// rather than on a timestamp.

/// "Today 4:12pm" / "Yesterday 9:03am" / "22 Aug 4:12pm". Absolute, not
/// "3 hours ago": picking a version is a decision about which moment you
/// want, and relative times make two nearby entries look alike.
export function versionTimestamp(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export function changeSummary(files: ProjectVersionFile[]): string {
  if (files.length === 0) return 'No files changed';
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  if (added === 0 && removed === 0) return count;
  return `${count} · +${added} −${removed}`;
}

function fileName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function VersionsSheet({ projectPath }: { projectPath: string }) {
  const openSheet = useStore((s) => s.openSheet);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const now = new Date();

  const load = useCallback(async () => {
    const res = await window.overcli.invoke('versions:list', { projectPath });
    if (res.ok) {
      setVersions(res.versions);
      setError(null);
    } else {
      setVersions([]);
      setError(res.error);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const showDiff = async (sha: string, file: string) => {
    setOpenFile(file);
    setDiff(null);
    const res = await window.overcli.invoke('versions:diff', { projectPath, sha, file });
    setDiff(res.ok ? res.diff : `Couldn't read that change.\n${res.error}`);
  };

  const restore = async (v: ProjectVersion) => {
    setBusy(v.sha);
    setError(null);
    const res = await window.overcli.invoke('versions:restore', {
      projectPath,
      sha: v.sha,
      label: versionTimestamp(v.at, now) || v.subject,
    });
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpenSha(null);
    setOpenFile(null);
    void load();
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="shrink-0 p-5 pb-3">
        <div className="text-lg font-semibold">Earlier versions</div>
        <div className="text-xs text-ink-faint mt-0.5">
          A version is saved whenever something finishes. Open one to see exactly what changed,
          then put the folder back to it — restoring makes a new version too, so you can always
          come forward again.
        </div>
      </div>

      {error && <div className="shrink-0 px-5 pb-2 text-xs text-red-500">{error}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-2">
        {versions.length === 0 && !error ? (
          <div className="py-6 text-center text-xs text-ink-faint">
            No versions yet. One gets saved the next time something finishes.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {versions.map((v, i) => {
              const expanded = openSha === v.sha;
              return (
                <div
                  key={v.sha}
                  className="rounded-lg border border-card bg-surface-elevated overflow-hidden"
                  style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => {
                        setOpenSha(expanded ? null : v.sha);
                        setOpenFile(null);
                        setDiff(null);
                      }}
                      className="flex items-start gap-2 text-left flex-1 min-w-0"
                    >
                      <span className="text-ink-faint mt-0.5 shrink-0">{expanded ? '▾' : '▸'}</span>
                      <span className="min-w-0">
                        <span className="block text-xs text-ink truncate">{v.subject}</span>
                        <span className="block text-[11px] text-ink-faint truncate">
                          {versionTimestamp(v.at, now)} · {changeSummary(v.files)}
                        </span>
                      </span>
                    </button>
                    {i === 0 ? (
                      <span className="shrink-0 text-[10px] text-ink-faint">Current</span>
                    ) : confirming === v.sha ? (
                      <div className="shrink-0 flex items-center gap-1.5">
                        <button
                          onClick={() => void restore(v)}
                          disabled={busy === v.sha}
                          className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-surface hover:bg-accent-600 disabled:opacity-50"
                        >
                          {busy === v.sha ? 'Restoring…' : 'Yes, restore'}
                        </button>
                        <button
                          onClick={() => setConfirming(null)}
                          className="px-1.5 py-1 text-[10px] text-ink-faint hover:text-ink"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirming(v.sha)}
                        className="shrink-0 rounded border border-card px-2 py-1 text-[10px] text-ink-muted hover:text-ink hover:bg-card-strong"
                      >
                        Restore
                      </button>
                    )}
                  </div>

                  {expanded && (
                    <div className="border-t border-card">
                      {v.files.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-ink-faint">
                          Nothing changed in this version.
                        </div>
                      ) : (
                        v.files.map((f) => {
                          const showing = openFile === f.path;
                          return (
                            <div key={f.path}>
                              <button
                                onClick={() =>
                                  showing ? setOpenFile(null) : void showDiff(v.sha, f.path)
                                }
                                disabled={f.binary}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-card-strong border-t border-card first:border-t-0 disabled:hover:bg-transparent"
                              >
                                <span className="flex-1 truncate text-[11px] text-ink">
                                  {fileName(f.path)}
                                </span>
                                {f.binary ? (
                                  <span className="text-[10px] text-ink-faint">
                                    image or document
                                  </span>
                                ) : (
                                  <>
                                    <span className="diff-add-ink text-[10px]">+{f.additions}</span>
                                    <span className="diff-remove-ink text-[10px]">
                                      −{f.deletions}
                                    </span>
                                  </>
                                )}
                              </button>
                              {showing && (
                                <div className="border-t border-card max-h-[40vh] overflow-auto bg-surface">
                                  {diff === null ? (
                                    <div className="px-3 py-2 text-[10px] text-ink-faint">
                                      Reading…
                                    </div>
                                  ) : (
                                    <Diff unifiedDiff={diff} compact />
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        {/* The docs told people this was possible and gave them no way to do
            it. Destructive and irreversible, so it confirms in place. */}
        {confirmOff ? (
          <>
            <span className="text-[11px] text-ink-muted flex-1">
              Stop saving versions and delete the ones above? Your documents are not touched.
            </span>
            <SheetActionButton
              label="Turn off history"
              onClick={async () => {
                const res = await window.overcli.invoke('git:removeHistory', { projectPath });
                setConfirmOff(false);
                if (!res.ok) setError(res.error);
                else openSheet(null);
              }}
            />
            <SheetActionButton label="Cancel" onClick={() => setConfirmOff(false)} />
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirmOff(true)}
              className="flex-1 text-left text-[11px] text-ink-faint hover:text-ink-muted"
            >
              Turn off history for this project
            </button>
            <SheetActionButton label="Done" onClick={() => openSheet(null)} />
          </>
        )}
      </div>
    </div>
  );
}
