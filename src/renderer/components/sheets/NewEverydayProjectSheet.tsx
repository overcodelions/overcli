import { useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';

export function NewEverydayProjectSheet() {
  const createEverydayProject = useStore((s) => s.createEverydayProject);
  const openSheet = useStore((s) => s.openSheet);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold">New everyday project</div>
          <div className="text-xs text-ink-faint">
            A prepared folder with somewhere to put your documents and somewhere for the results.
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
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={working ? 'Creating…' : 'Create project'}
          disabled={working || !name.trim()}
          onClick={async () => {
            setWorking(true);
            const res = await createEverydayProject(name, goal);
            setWorking(false);
            if (res.ok && res.historyOn) openSheet(null);
            else if (res.ok) {
              setError("Made the folder, but couldn't start its history — it already sits inside another project's history. Overcli can still work here, but Undo won't be available.");
            } else {
              setError(res.error);
            }
          }}
        />
      </div>
    </div>
  );
}
