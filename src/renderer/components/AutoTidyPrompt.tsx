// Auto-tidy's first-time ask. While auto-run is undecided the timer finds
// what is due and parks it here instead of removing it — see cleanupScan.
// Saying yes retires this batch and turns auto-run on; nothing is deleted
// unattended until someone has.

import { useState } from 'react';
import { useStore } from '../store';
import { DEFAULT_CLEANUP_RULES } from '@shared/cleanupRules';
import {
  confirmAutoTidy,
  declineAutoTidy,
  useCleanupScan,
} from './sheets/cleanupScan';

export function AutoTidyPrompt() {
  const pending = useCleanupScan((s) => s.pendingConsent);
  const rules = useStore((s) => s.settings.cleanup) ?? DEFAULT_CLEANUP_RULES;
  const [busy, setBusy] = useState(false);
  if (!pending) return null;

  const n = pending.selected.length;
  const chats = pending.selected.filter((e) => e.claim?.convId && !e.claim?.runId).length;
  const age = rules.retireAfterDays === 1 ? 'a day' : `${rules.retireAfterDays} days`;

  return (
    <div className="fixed bottom-4 left-4 z-[60] max-w-[360px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl px-4 py-3 text-xs flex flex-col gap-2">
      <div className="text-ink font-medium">
        Auto-tidy found {n} finished worktree{n === 1 ? '' : 's'} to retire
      </div>
      <div className="text-ink-muted">
        Clean and merged, older than {age}, past the newest {rules.keepPerProducer} per worker or
        flow. Branches are kept
        {chats > 0 ? `, and the ${chats} chat${chats === 1 ? '' : 's'} keep their conversation` : ''}
        . Retiring turns auto-tidy on, so later batches go without asking.
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          disabled={busy}
          className="text-xs px-3 py-1 rounded-md bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void confirmAutoTidy().finally(() => setBusy(false));
          }}
        >
          {busy ? 'Retiring…' : `Retire ${n}`}
        </button>
        <button
          disabled={busy}
          className="text-xs px-2 py-1 rounded-md text-ink-muted hover:text-ink"
          onClick={() => {
            void declineAutoTidy(false);
            useStore.getState().openSheet({ type: 'cleanup' });
          }}
        >
          Review in Clean up
        </button>
        <button
          disabled={busy}
          className="text-xs px-2 py-1 rounded-md text-ink-faint hover:text-ink"
          onClick={() => void declineAutoTidy(false)}
        >
          Not now
        </button>
        <button
          disabled={busy}
          className="text-xs px-2 py-1 rounded-md text-ink-faint hover:text-ink ml-auto"
          onClick={() => void declineAutoTidy(true)}
        >
          Turn off
        </button>
      </div>
    </div>
  );
}
