// "Upgrade models" for the flows library: a one-line strip when saved flows
// pin models that have a newer release in the same line, and the review modal
// it opens. Nothing moves until the user has seen the exact change and ticked
// it — a pin can be deliberate, and a model swap changes cost and behaviour.
// Unticked changes are remembered as declined so the strip doesn't nag; the
// skip key includes the target, so the next release is offered afresh.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import {
  modelUpgradeSkipKey,
  pendingModelUpgrades,
  shortModelChangeLabel,
  type FlowModelChange,
  type FlowModelUpgrade,
} from '@shared/flows/modelUpgrade';
import { flowStarKey, type Flow } from '@shared/flows/schema';
import { friendlyModelLabel } from '@shared/modelCatalog';

/// The upgrades the library should currently offer, minus declined ones.
export function usePendingModelUpgrades(flows: Flow[]): FlowModelUpgrade[] {
  const skipped = useStore((s) => s.settings.skippedModelUpgrades);
  return useMemo(() => pendingModelUpgrades(flows, skipped ?? []), [flows, skipped]);
}

function pairLabel(c: Pick<FlowModelChange, 'backend' | 'from' | 'to'>): string {
  return `${friendlyModelLabel(c.backend, c.from)} → ${friendlyModelLabel(c.backend, c.to)}`;
}

export function ModelUpgradeStrip({
  upgrades,
  onOpen,
}: {
  upgrades: FlowModelUpgrade[];
  onOpen: () => void;
}) {
  // Distinct model moves across all flows, most common first — "Opus 5 →
  // Opus 5.5" is the headline, not which flow happens to be listed first.
  const pairs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const u of upgrades) {
      for (const c of u.changes) {
        const label = shortModelChangeLabel(c);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  }, [upgrades]);

  if (upgrades.length === 0) return null;
  const shown = pairs.slice(0, 3).join(', ');
  const more = pairs.length > 3 ? ` +${pairs.length - 3} more` : '';
  return (
    <button
      onClick={onOpen}
      className="w-full mb-5 flex items-center gap-2 text-left rounded-md border border-accent/40 bg-accent/5 px-3 py-1.5 hover:bg-accent/10 transition-colors"
    >
      <span className="text-[11px] text-accent">↑</span>
      <span className="text-[11px] text-ink truncate">
        {upgrades.length === 1 ? '1 flow runs' : `${upgrades.length} flows run`} an older model
        <span className="text-ink-muted"> · {shown}{more}</span>
      </span>
      <span className="ml-auto text-[11px] text-accent whitespace-nowrap">Review →</span>
    </button>
  );
}

export function ModelUpgradeModal({
  upgrades: offered,
  projectPaths,
  onClose,
}: {
  upgrades: FlowModelUpgrade[];
  projectPaths: string[];
  onClose: () => void;
}) {
  const upgradeFlowModels = useFlowsStore((s) => s.upgradeFlowModels);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  // Frozen at open. The library reloads underneath (a save elsewhere, or our
  // own partial-failure reload), and a change that appeared mid-review would
  // otherwise start unticked and be recorded as declined without being seen.
  const [upgrades] = useState(offered);
  // Everything starts ticked: the strip already asked "want these?", and the
  // modal's job is letting the user untick the pins they meant.
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(upgrades.flatMap((u) => u.changes.map((c) => modelUpgradeSkipKey(u.flow, c)))),
  );
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // The same move (Opus 5 → 5.5) usually repeats across most of the list, so
  // the header offers one checkbox per move to set every row at once.
  const moves = useMemo(() => {
    const byMove = new Map<string, { change: FlowModelChange; keys: string[] }>();
    for (const u of upgrades) {
      for (const c of u.changes) {
        const id = `${c.backend}|${c.from}|${c.to}`;
        const entry = byMove.get(id) ?? { change: c, keys: [] };
        entry.keys.push(modelUpgradeSkipKey(u.flow, c));
        byMove.set(id, entry);
      }
    }
    return [...byMove.entries()]
      .sort((a, b) => b[1].keys.length - a[1].keys.length)
      .map(([id, v]) => ({ id, ...v }));
  }, [upgrades]);

  function setMany(keys: string[], on: boolean): void {
    setTicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  const total = upgrades.reduce((n, u) => n + u.changes.length, 0);
  const tickedCount = ticked.size;
  const touchesProject = upgrades.some(
    (u) => u.flow.source === 'project' && u.changes.some((c) => ticked.has(modelUpgradeSkipKey(u.flow, c))),
  );

  function toggle(key: string): void {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply(): Promise<void> {
    setBusy(true);
    const chosen: FlowModelUpgrade[] = [];
    const declined: string[] = [];
    for (const u of upgrades) {
      const keep: FlowModelChange[] = [];
      for (const c of u.changes) {
        const key = modelUpgradeSkipKey(u.flow, c);
        if (ticked.has(key)) keep.push(c);
        else declined.push(key);
      }
      if (keep.length > 0) chosen.push({ flow: u.flow, changes: keep });
    }
    const result = await upgradeFlowModels(chosen, projectPaths);
    if (declined.length > 0) {
      const prior = settings.skippedModelUpgrades ?? [];
      await saveSettings({
        ...settings,
        skippedModelUpgrades: [...prior, ...declined.filter((k) => !prior.includes(k))],
      });
    }
    setBusy(false);
    if (result.errors.length > 0) setErrors(result.errors);
    else onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[880px] max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card">
          <div>
            <div className="text-lg font-semibold">Upgrade flow models</div>
            <div className="text-xs text-ink-muted mt-0.5">
              Each change stays in the same model line. Untick any pin you chose on purpose.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto self-start text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        {moves.length > 1 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2.5 border-b border-card bg-card/30">
            <span className="text-[11px] text-ink-faint">All flows:</span>
            {moves.map((m) => {
              const on = m.keys.filter((k) => ticked.has(k)).length;
              return (
                <MoveToggle
                  key={m.id}
                  label={shortModelChangeLabel(m.change)}
                  count={m.keys.length}
                  state={on === 0 ? 'none' : on === m.keys.length ? 'all' : 'some'}
                  disabled={busy}
                  onChange={(next) => setMany(m.keys, next)}
                />
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {upgrades.map((u) => (
            <div key={flowStarKey(u.flow)}>
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                {u.flow.name}
                {u.flow.source === 'project' && (
                  <span className="text-[10px] font-normal text-ink-faint border border-card rounded px-1">
                    project
                  </span>
                )}
                {u.flow.archived && (
                  <span className="text-[10px] font-normal text-ink-faint border border-card rounded px-1">
                    archived
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1">
                {u.changes.map((c) => {
                  const key = modelUpgradeSkipKey(u.flow, c);
                  return (
                    <label key={key} className="flex items-start gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ticked.has(key)}
                        onChange={() => toggle(key)}
                        disabled={busy}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="text-ink">{pairLabel(c)}</span>
                        <span className="text-ink-faint"> · {c.where.join(', ')}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {errors.length > 0 && (
          <div className="mx-5 mb-2 text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-400/40 rounded px-3 py-2 space-y-0.5">
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 px-5 py-4 border-t border-card">
          <div className="text-[11px] text-ink-faint">
            {tickedCount < total
              ? 'Unticked changes won’t be offered again.'
              : touchesProject
                ? 'Project flows are written into their repo’s .overcli/flows/.'
                : 'Existing runs keep the model they started with.'}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto text-xs px-3 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={() => void apply()}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 font-medium disabled:opacity-50"
          >
            {busy
              ? 'Saving…'
              : tickedCount === 0
                ? 'Skip all'
                : `Upgrade ${tickedCount} ${tickedCount === 1 ? 'change' : 'changes'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/// One header checkbox per model move. Mixed when the user has hand-ticked
/// some of its rows; clicking a mixed box ticks them all.
function MoveToggle({
  label,
  count,
  state,
  disabled,
  onChange,
}: {
  label: string;
  count: number;
  state: 'all' | 'some' | 'none';
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
      <input
        ref={ref}
        type="checkbox"
        checked={state === 'all'}
        onChange={() => onChange(state !== 'all')}
        disabled={disabled}
      />
      <span className="text-ink">{label}</span>
      <span className="text-ink-faint">· {count}</span>
    </label>
  );
}
