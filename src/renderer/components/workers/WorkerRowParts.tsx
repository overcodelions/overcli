import { useState } from 'react';

import { useStore } from '../../store';
import { useOrchestratorStore } from '../../orchestratorStore';
import type { Orchestration } from '@shared/flows/orchestration';
import type { WorkerTrustLevel } from '@shared/flows/worker';

export const TRUST_LABEL: Record<WorkerTrustLevel, { text: string; cls: string }> = {
  probation: { text: 'probation', cls: 'text-amber-600 dark:text-amber-400 border-amber-400/40' },
  trusted: { text: 'trusted', cls: 'text-sky-600 dark:text-sky-400 border-sky-400/40' },
  autonomous: {
    text: 'autonomous',
    cls: 'text-emerald-600 dark:text-emerald-400 border-emerald-400/40',
  },
};

/// A worker's parked output. Review actions remain owned by the existing
/// orchestrator surfaces; both desks and the Workers tab use this exact row.
export function WorkerPendingProposal({ orchestration }: { orchestration: Orchestration }) {
  const setDetailMode = useStore((s) => s.setDetailMode);
  const setActiveOrchestration = useOrchestratorStore((s) => s.setActiveOrchestration);
  const [busy, setBusy] = useState(false);
  const proposed = orchestration.items.filter((i) => i.status === 'proposed');

  function review(): void {
    setActiveOrchestration(orchestration.id);
    setDetailMode('orchestrator');
  }

  async function launchAll(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.overcli.invoke('orchestrator:approveBatch', { id: orchestration.id });
      review();
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.overcli.invoke('orchestrator:abort', { id: orchestration.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-violet-400/40 bg-violet-500/10 px-2.5 py-2">
      <div className="text-[12px] text-ink">
        <span className="font-semibold">{orchestration.title}</span>
        <span className="text-ink-muted">
          {' '}
          — {proposed.length} proposal{proposed.length === 1 ? '' : 's'} waiting for your review.
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={review}
          className="text-[11px] px-2 py-0.5 rounded border border-card-strong hover:bg-white/5"
        >
          Review &amp; pick →
        </button>
        <button
          disabled={busy}
          onClick={() => void launchAll()}
          className="text-[11px] px-2 py-0.5 rounded bg-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          Launch all {proposed.length}
        </button>
        <button
          disabled={busy}
          onClick={() => void discard()}
          className="text-[11px] px-2 py-0.5 rounded text-ink-faint hover:text-red-400"
        >
          Reject all
        </button>
      </div>
    </div>
  );
}
