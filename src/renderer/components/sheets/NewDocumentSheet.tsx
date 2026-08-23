import { useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { DOCUMENT_TYPES, isEverydayProject } from '@shared/everydayProjects';

/// Two ways to start a document, in one sheet.
///
/// "Describe it" is the headline: the user says "a one-page summary of our Q3
/// results for the board" and a finished document lands in the folder. It
/// runs on the same one-shot drafting transport as the flow and worker
/// drafters — whichever CLI they are already signed in to.
///
/// "Blank" is the escape hatch, and it matters more than it looks. Someone
/// who already knows what they want to write should not have to wait on a
/// model, or talk it into producing an empty page.

const EXAMPLES = [
  'A one-page summary of our Q3 results for the board',
  'A meeting agenda for a 30-minute project kickoff',
  'A simple budget spreadsheet for a team offsite',
];

type Mode = 'describe' | 'blank';

export function NewDocumentSheet({ dirPath }: { dirPath: string }) {
  const openSheet = useStore((s) => s.openSheet);
  const openFile = useStore((s) => s.openFile);
  const checkpointProject = useStore((s) => s.checkpointProject);
  const inEverydayProject = useStore((s) =>
    s.projects.some((p) => (dirPath === p.path || dirPath.startsWith(`${p.path}/`)) && isEverydayProject(p)),
  );
  const [mode, setMode] = useState<Mode>('describe');
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [ext, setExt] = useState(DOCUMENT_TYPES[0].ext);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = working ? false : mode === 'describe' ? !!description.trim() : !!name.trim();

  const submit = async () => {
    if (!canSubmit) return;
    setWorking(true);
    setError(null);
    const res =
      mode === 'describe'
        ? await window.overcli.invoke('fs:createDocumentFromPrompt', { dirPath, description })
        : await window.overcli.invoke('fs:createBlankDocument', { dirPath, name, ext });
    setWorking(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const created = res.path.slice(res.path.lastIndexOf('/') + 1);
    // Everyday projects only. This sheet is also reachable from a code repo
    // via the explorer's "+ Document", and committing someone's entire dirty
    // working tree because they made a note would be indefensible.
    if (inEverydayProject) {
      void checkpointProject(dirPath, `Created ${created}`);
    }
    openSheet(null);
    openFile(res.path);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold">New document</div>
          <div className="text-xs text-ink-faint">
            Describe what you want and have it written, or start from a blank page.
          </div>
        </div>

        <div className="flex gap-1 p-0.5 rounded-md bg-card w-fit">
          {(['describe', 'blank'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={
                'rounded px-3 py-1 text-xs transition-colors ' +
                (mode === m
                  ? 'bg-surface-elevated text-ink'
                  : 'text-ink-muted hover:text-ink')
              }
            >
              {m === 'describe' ? 'Describe it' : 'Blank'}
            </button>
          ))}
        </div>

        {mode === 'describe' ? (
          <>
            <div>
              <label className="text-xs text-ink-faint">What do you want?</label>
              <textarea
                autoFocus
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘↵ matches the editor's save and the composer's send — the
                  // two other places where ↵ alone must stay a newline.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
                }}
                placeholder="A one-page summary of our Q3 results for the board"
                rows={4}
                className="field mt-1 w-full px-3 py-1.5 text-sm resize-y"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setDescription(ex)}
                  disabled={working}
                  className="rounded-full border border-card px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink hover:bg-card-strong disabled:opacity-50"
                >
                  {ex}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="text-xs text-ink-faint">Name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                placeholder="Q3 marketing plan"
                className="field mt-1 w-full px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-ink-faint">Type</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DOCUMENT_TYPES.map((t) => (
                  <button
                    key={t.ext}
                    onClick={() => setExt(t.ext)}
                    className={
                      'rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
                      (ext === t.ext
                        ? 'accent-soft text-accent'
                        : 'border-card text-ink-muted hover:text-ink hover:bg-card-strong')
                    }
                  >
                    {t.label} <span className="text-ink-faint">.{t.ext}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {error && <div className="text-xs text-red-500">{error}</div>}
      </div>

      <div className="flex items-center gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        <div className="flex-1 text-[11px] text-ink-faint">
          {working && mode === 'describe' ? 'Writing it…' : 'Lands in this folder, then opens.'}
        </div>
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={working ? (mode === 'describe' ? 'Writing…' : 'Creating…') : 'Create'}
          disabled={!canSubmit}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}
