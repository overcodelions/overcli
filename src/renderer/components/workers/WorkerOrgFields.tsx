// Where a worker sits in the org: the person it answers to, the worker it
// reports to, and who may ask it things. One card in the worker editor.
//
// All optional, and empty for every worker hired before the org layer: a
// worker with no manager keeps asking its questions in the app, exactly as
// before. Setting a manager's Slack member ID is what moves them to Slack.

import { useMemo } from 'react';
import type { UUID } from '@shared/types';
import {
  WORKER_VISIBILITIES,
  WORKER_VISIBILITY_LABEL,
  isSlackUserId,
  sortRoster,
  type Worker,
  type WorkerManager,
  type WorkerVisibility,
} from '@shared/flows/worker';
import { managerFor, wouldCycle } from '@shared/flows/org';

export interface WorkerOrgDraft {
  id?: UUID;
  manager?: WorkerManager;
  reportsTo?: UUID;
  visibility?: WorkerVisibility;
  avatarUrl?: string;
}

const INPUT = 'w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink';

function Label({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</span>
      {hint && <span className="text-[11px] text-ink-faint normal-case">{hint}</span>}
    </div>
  );
}

export function WorkerOrgFields({
  draft,
  workers,
  patch,
}: {
  draft: WorkerOrgDraft;
  workers: Record<string, Worker>;
  patch: (p: Partial<WorkerOrgDraft>) => void;
}) {
  const roster = useMemo(() => Object.values(workers), [workers]);
  // Anyone but itself and anyone already under it — picking one of those
  // would make a loop, which the engine refuses on save anyway.
  const bosses = useMemo(
    () => sortRoster(roster.filter((w) => w.id !== draft.id && !(draft.id && wouldCycle(roster, draft.id, w.id)))),
    [roster, draft.id],
  );
  // What a question falls back to when this worker has no manager of its own.
  const inherited = useMemo(() => {
    if (draft.manager || !draft.reportsTo) return undefined;
    const probe = [...roster.filter((w) => w.id !== draft.id), { id: '\u0000draft', reportsTo: draft.reportsTo, enabled: true }];
    return managerFor(probe as Worker[], '\u0000draft');
  }, [roster, draft.id, draft.manager, draft.reportsTo]);

  const manager = draft.manager;
  const slackId = manager?.slackUserId ?? '';
  const slackBad = slackId.trim() !== '' && !isSlackUserId(slackId.trim());

  const setManager = (next: Partial<WorkerManager>) => {
    const merged = { name: manager?.name ?? '', slackUserId: manager?.slackUserId, ...next };
    // An emptied pair is "no manager", not a nameless one the engine would refuse.
    if (!merged.name.trim() && !merged.slackUserId?.trim()) patch({ manager: undefined });
    else patch({ manager: { name: merged.name, ...(merged.slackUserId ? { slackUserId: merged.slackUserId } : {}) } });
  };

  return (
    <div className="space-y-5">
      <div>
        <Label label="Manager" hint="the person its questions and approvals go to" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
          <input
            aria-label="Manager's name"
            value={manager?.name ?? ''}
            onChange={(e) => setManager({ name: e.target.value })}
            placeholder={inherited ? `${inherited.name} (from the worker it reports to)` : 'Pat Lee'}
            className={INPUT}
          />
          <input
            aria-label="Manager's Slack member ID"
            value={slackId}
            onChange={(e) => setManager({ slackUserId: e.target.value.trim() || undefined })}
            placeholder="Slack member ID"
            className={INPUT + ' font-mono ' + (slackBad ? 'border-red-400/60' : '')}
          />
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {slackBad
            ? 'A member ID looks like U012AB3CD — in Slack, open their profile, ⋯, Copy member ID.'
            : slackId
              ? 'Questions nobody up the chain can answer, and approvals, arrive as DMs from this worker. Replies come straight back.'
              : 'Without a Slack member ID, questions wait in overcli as they always have.'}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label label="Reports to" />
          <select
            aria-label="Reports to"
            value={draft.reportsTo ?? ''}
            onChange={(e) => patch({ reportsTo: e.target.value || undefined })}
            className={INPUT}
          >
            <option value="">Nobody — top of its branch</option>
            {bosses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.enabled ? '' : ' (paused)'}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            A question it cannot answer goes to this worker first, then up the chain, before it reaches a person.
          </div>
        </div>
        <div>
          <Label label="Who may ask it" />
          <select
            aria-label="Who may ask it"
            value={draft.visibility ?? 'private'}
            onChange={(e) => {
              const v = e.target.value as WorkerVisibility;
              patch({ visibility: v === 'private' ? undefined : v });
            }}
            className={INPUT}
          >
            {WORKER_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {WORKER_VISIBILITY_LABEL[v]}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Anyone who can ask it can learn what its tools can reach. Keep a worker with sensitive tools narrow.
          </div>
        </div>
      </div>

      <div>
        <Label label="Avatar" hint="an https image — its face in Slack" />
        <input
          value={draft.avatarUrl ?? ''}
          onChange={(e) => patch({ avatarUrl: e.target.value.trim() || undefined })}
          placeholder="https://…"
          className={INPUT + ' font-mono'}
        />
      </div>
    </div>
  );
}
