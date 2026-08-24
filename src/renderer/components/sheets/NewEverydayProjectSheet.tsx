import { useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { GitInstallNotice } from '../GitInstallNotice';
import { sheetSubmitKeys } from './sheetSubmit';
import type { InitRepoFailure } from '@shared/types';

export function NewEverydayProjectSheet() {
  const createEverydayProject = useStore((s) => s.createEverydayProject);
  const openSheet = useStore((s) => s.openSheet);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// Set once the folder exists. The folder is created before the history is
  /// started, so a history failure used to leave this sheet open with the
  /// Create button still live — and the obvious retry made a SECOND folder
  /// ("Marketing copy review 2"), both registered, both with a conversation.
  /// After a successful creation there is nothing left to create.
  const [madeWithoutHistory, setMadeWithoutHistory] = useState<InitRepoFailure | null>(null);

  const submit = async () => {
    if (working || !name.trim() || madeWithoutHistory) return;
    setWorking(true);
    const res = await createEverydayProject(name, goal);
    setWorking(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.historyOn) {
      openSheet(null);
      return;
    }
    // The folder exists and is already registered. Say why undo
    // is missing using the reason the main process reported —
    // this used to assert "it already sits inside another
    // project's history" for every cause, including no git.
    setMadeWithoutHistory(res.historyReason);
    setError(
      res.historyReason === 'no-git' || res.historyReason === 'needs-xcode-tools'
        ? null
        : res.historyReason === 'already-tracked'
          ? "Made the folder, but couldn't start its history — it already sits inside another project's history. Overcli can still work here, but Undo won't be available."
          : `Made the folder, but couldn't start its history. ${res.historyError} Overcli can still work here, but Undo won't be available.`,
    );
  };

  return (
    <div className="flex flex-col min-h-0 flex-1" onKeyDown={sheetSubmitKeys(() => void submit())}>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold">New everyday project</div>
          <div className="text-xs text-ink-faint">
            A prepared folder for your documents, with every version saved so you can undo anything.
          </div>
        </div>
        <div>
          <label className="text-xs text-ink-faint">What should we call it?</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Marketing copy review"
            className="field mt-1 w-full px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-ink-faint">What do you want to get done?</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Review our marketing drafts for tone, claims and consistency."
            rows={4}
            className="field mt-1 w-full px-3 py-1.5 text-sm resize-y"
          />
        </div>
        <div className="text-[10px] text-ink-faint">
          Overcli keeps a history of this folder so you can undo anything it changes.
        </div>
        {error && <div className="text-xs text-red-500">{error}</div>}
        {(madeWithoutHistory === 'no-git' || madeWithoutHistory === 'needs-xcode-tools') && (
          <GitInstallNotice
            state={madeWithoutHistory === 'needs-xcode-tools' ? 'needs-xcode-tools' : 'missing'}
            lead="The folder is ready and Overcli can work in it — but Undo won’t be available."
          />
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        {madeWithoutHistory ? (
          <SheetActionButton primary label="Done" onClick={() => openSheet(null)} />
        ) : (
          <>
            <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
            <SheetActionButton
              primary
              label={working ? 'Creating…' : 'Create project'}
              disabled={working || !name.trim()}
              onClick={() => void submit()}
            />
          </>
        )}
      </div>
    </div>
  );
}
