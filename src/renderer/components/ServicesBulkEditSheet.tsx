// Setting a few things on many services, and seeing what that would do first.
//
// The controls this replaces lived on the selection bar: a 40px strip inside a
// column that drags down to 300px. Two settings already overflowed it, and
// each of them reported what it had done afterwards, in a toast — you switched
// eight services and then learned three had no such branch.
//
// So: one surface, five fields, and a preview that answers "what will this do"
// before the click rather than after it. Start, Stop and Remove stay on the
// bar, because those are verbs you fire and watch, not settings you choose.
//
// The rule everything rests on: a field left alone is never written.

import { useMemo, useState } from 'react';
import { useServicesStore, splitKey } from '../servicesStore';
import { reloadModeOf, type ReloadMode } from '../serviceReloadMode';
import {
  describeReady,
  planBulkEdit,
  type BulkEdits,
  type BulkService,
  type FieldKey,
  type ReadyShape,
} from '../servicesBulkEdit';

/// One hue per field, so a preview with several fields set stays scannable:
/// which rows move branch, and which only change what they do on a save.
const FIELD_TINT: Record<FieldKey, { bg: string; ink: string; dot: string }> = {
  branch: { bg: 'rgba(124,139,255,0.16)', ink: '#aab3ff', dot: 'rgba(124,139,255,0.7)' },
  reload: { bg: 'rgba(61,206,215,0.16)', ink: '#5fdbe2', dot: 'rgba(61,206,215,0.7)' },
  group: { bg: 'rgba(181,135,255,0.16)', ink: '#c8a6ff', dot: 'rgba(181,135,255,0.7)' },
  ready: { bg: 'rgba(52,211,153,0.16)', ink: '#6ee7b7', dot: 'rgba(52,211,153,0.7)' },
};

const FIELD_LABEL: Record<FieldKey, string> = {
  branch: 'branch',
  reload: 'on change',
  group: 'group',
  ready: 'ready when',
};

const RELOAD_CHOICES: { mode: ReloadMode; label: string }[] = [
  { mode: 'restart', label: 'Restart the service' },
  { mode: 'self', label: 'It reloads itself' },
  { mode: 'off', label: 'Do nothing' },
];

const READY_CHOICES: { kind: ReadyShape['kind']; label: string }[] = [
  { kind: 'http', label: 'HTTP responds' },
  { kind: 'tcp', label: 'Port accepts a connection' },
  { kind: 'log', label: 'Output matches' },
  { kind: 'none', label: 'As soon as it starts' },
];

export function ServicesBulkEditSheet({ keys, onClose }: { keys: string[]; onClose: () => void }) {
  const stacks = useServicesStore((s) => s.stacks);
  const choices = useServicesStore((s) => s.choices);
  const applyBulkEdit = useServicesStore((s) => s.applyBulkEdit);

  const [edits, setEdits] = useState<BulkEdits>({});
  const [applying, setApplying] = useState(false);

  const services: BulkService[] = useMemo(
    () =>
      keys.flatMap((key) => {
        const { workspaceId, serviceId } = splitKey(key);
        const stack = stacks[workspaceId];
        const spec = stack?.services.find((s) => s.id === serviceId);
        if (!spec) return [];
        return [{
          key,
          name: spec.name,
          spec,
          ref: stack?.bindings.find((b) => b.serviceId === serviceId)?.ref,
          reachableRefs: (choices[serviceId] ?? []).map((c) => c.ref),
        }];
      }),
    [keys, stacks, choices],
  );

  const plan = useMemo(() => planBulkEdit(services, edits), [services, edits]);
  const touched = (Object.keys(edits) as (keyof BulkEdits)[]).filter((k) => k !== 'pin' && edits[k] !== undefined);
  const activeFields = new Set(plan.rows.flatMap((r) => r.changes.map((c) => c.field)));

  const refOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of services) {
      for (const ref of new Set(service.reachableRefs)) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [services]);

  const groupOptions = useMemo(
    () => [...new Set(Object.values(stacks).flatMap((s) => s.services.map((x) => x.group).filter(Boolean)))].sort(),
    [stacks],
  ) as string[];

  const apply = () => {
    setApplying(true);
    void applyBulkEdit(keys, edits)
      .then(onClose)
      .catch(() => setApplying(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex h-[min(680px,calc(100vh-64px))] w-[min(940px,calc(100vw-64px))] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start gap-3 border-b border-card px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">
              Edit {keys.length} service{keys.length === 1 ? '' : 's'}
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-ink-muted">{summarise(services)}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[320px] flex-shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-card px-5 py-4">
            <div className="text-[11px] font-semibold text-ink-muted">Set on all {keys.length}</div>

            <Field
              label="Branch"
              help="Each one moves inside its own repository. Any that has no such branch stays put."
              value={edits.ref}
              mixed={mixedOf(services.map((s) => s.ref ?? ''))}
              onClear={() => setEdits((e) => ({ ...e, ref: undefined, pin: undefined }))}
              options={refOptions.map(([ref, n]) => ({
                value: ref,
                label: ref,
                note: n === services.length ? undefined : `${n} of ${services.length}`,
                mono: true,
              }))}
              onPick={(ref) => setEdits((e) => ({ ...e, ref }))}
              empty="No branch is shared by these repositories."
            />
            {edits.ref !== undefined && (
              <label className="-mt-1.5 flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={!!edits.pin}
                  onChange={(e) => setEdits((prev) => ({ ...prev, pin: e.target.checked }))}
                />
                <span>Pin them there, so later switches leave them alone</span>
              </label>
            )}

            <Field
              label="On file change"
              help="Keeps each service's own watch patterns."
              value={edits.reload && RELOAD_CHOICES.find((c) => c.mode === edits.reload)?.label}
              mixed={mixedOf(services.map((s) => reloadModeOf(s.spec)))}
              onClear={() => setEdits((e) => ({ ...e, reload: undefined }))}
              options={RELOAD_CHOICES.map((c) => ({ value: c.mode, label: c.label }))}
              onPick={(mode) => setEdits((e) => ({ ...e, reload: mode as ReloadMode }))}
            />

            <Field
              label="Group"
              help="Where they sit in the list. Nothing restarts."
              value={edits.group === undefined ? undefined : edits.group || 'ungrouped'}
              mixed={mixedOf(services.map((s) => s.spec.group ?? ''))}
              onClear={() => setEdits((e) => ({ ...e, group: undefined }))}
              options={[
                ...groupOptions.map((g) => ({ value: g, label: g })),
                { value: '', label: 'No group' },
              ]}
              onPick={(group) => setEdits((e) => ({ ...e, group }))}
              empty="No groups yet."
            />

            <Field
              label="Ready when"
              help="Keeps each service's own port. One with no port cannot take an HTTP or TCP probe."
              value={edits.ready && READY_CHOICES.find((c) => c.kind === edits.ready?.kind)?.label}
              mixed={mixedOf(services.map((s) => describeReady(s.spec.ready)))}
              onClear={() => setEdits((e) => ({ ...e, ready: undefined }))}
              options={READY_CHOICES.map((c) => ({ value: c.kind, label: c.label }))}
              onPick={(kind) =>
                setEdits((e) => ({
                  ...e,
                  ready:
                    kind === 'http'
                      ? { kind: 'http', path: '/actuator/health' }
                      : kind === 'log'
                        ? { kind: 'log', pattern: 'Started' }
                        : kind === 'tcp'
                          ? { kind: 'tcp' }
                          : { kind: 'none' },
                }))
              }
            />
            {edits.ready?.kind === 'http' && (
              <ProbeInput
                label="Path"
                value={edits.ready.path}
                onChange={(path) => setEdits((e) => ({ ...e, ready: { kind: 'http', path } }))}
              />
            )}
            {edits.ready?.kind === 'log' && (
              <ProbeInput
                label="Pattern"
                value={edits.ready.pattern}
                onChange={(pattern) => setEdits((e) => ({ ...e, ready: { kind: 'log', pattern } }))}
              />
            )}

            <div className="mt-auto border-t border-card pt-2.5 text-[11px] text-ink-muted">
              A field left alone is never written.
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-shrink-0 items-center gap-3 px-5 pb-2 pt-4">
              <div className="flex-1 text-[11px] font-semibold text-ink-muted">What changes</div>
              {activeFields.size > 1 && (
                <div className="flex items-center gap-2.5 text-[10.5px]">
                  {[...activeFields].map((field) => (
                    <span key={field} className="flex items-center gap-1.5" style={{ color: FIELD_TINT[field].ink }}>
                      <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: FIELD_TINT[field].dot }} />
                      {FIELD_LABEL[field]}
                    </span>
                  ))}
                </div>
              )}
              <div className="font-mono text-[10.5px] text-ink-muted">
                {touched.length === 0 ? 'nothing yet' : countLine(plan)}
              </div>
            </div>

            <div className="flex-shrink-0 border-b border-card px-5 pb-1.5 text-[10.5px] text-ink-muted">
              <div className="flex items-center gap-3">
                <span className="w-[132px]">Service</span>
                <span className="flex-1">Now</span>
                <span className="w-4" />
                <span className="flex-1">After</span>
              </div>
            </div>

            {/* Scrolls rather than capping: the whole point is seeing every
                service the apply will touch, and a stack is often twenty. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
              {plan.rows.map((row) => (
                <div
                  key={row.key}
                  className={
                    'flex min-h-[38px] items-center gap-3 border-b border-card py-1.5 ' +
                    (row.changes.length === 0 && row.blocks.length === 0 ? 'opacity-55' : '')
                  }
                >
                  <span className="w-[132px] truncate font-mono text-[12px] text-ink">{row.name}</span>
                  {row.changes.length === 0 && row.blocks.length === 0 ? (
                    <>
                      <span className="flex-1" />
                      <span className="w-4" />
                      <span className="flex-1 text-[11px] text-ink-muted">
                        {touched.length === 0 ? 'no change' : 'already there'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate font-mono text-[11px] text-ink-muted">
                        {row.changes.map((c) => c.now).join(' · ') || '—'}
                      </span>
                      <span className="w-4 text-[13px]" style={{ color: row.changes.length ? '#7c8bff' : 'transparent' }}>
                        {row.changes.length ? '→' : ''}
                      </span>
                      <span className="flex flex-1 flex-wrap items-center gap-1.5">
                        {row.changes.map((c) => (
                          <span
                            key={c.field}
                            className="inline-block rounded px-1.5 py-0.5 font-mono text-[11px]"
                            style={{ background: FIELD_TINT[c.field].bg, color: FIELD_TINT[c.field].ink }}
                          >
                            {c.after}
                          </span>
                        ))}
                        {row.blocks.map((b) => (
                          <span key={b.field} className="flex items-center gap-1.5">
                            <span className="h-[6px] w-[6px] rounded-full bg-amber-400" />
                            <span className="text-[10.5px] text-amber-600 dark:text-amber-300">{b.reason}</span>
                          </span>
                        ))}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-3 border-t border-card bg-surface-muted px-5 py-3">
          <div className="flex-1 text-[11px] text-ink-muted">
            {plan.blocked > 0 ? (
              <span className="text-amber-600 dark:text-amber-300">
                {plan.blocked} cannot take every change. Each says why in its row.
              </span>
            ) : touched.length === 0 ? (
              'Set a field to see what it would do.'
            ) : (
              countLine(plan)
            )}
          </div>
          <button type="button" className="svc-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={plan.changing === 0 || applying}
            onClick={apply}
            className="h-[26px] rounded-md bg-accent px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying
              ? 'Applying…'
              : plan.changing === 0
                ? 'Nothing to apply'
                : `Apply to ${plan.changing} service${plan.changing === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/// A tri-state field: leave as is, mixed, or set. Only the third writes.
function Field({
  label,
  help,
  value,
  mixed,
  options,
  onPick,
  onClear,
  empty,
}: {
  label: string;
  help: string;
  /// The chosen value, or undefined for "leave as is".
  value?: string;
  /// How many distinct values the selection has now, when it has more than one.
  mixed?: number;
  options: { value: string; label: string; note?: string; mono?: boolean }[];
  onPick: (value: string) => void;
  onClear: () => void;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const set = value !== undefined;

  return (
    <div className="relative flex flex-col gap-1.5">
      <span className="text-[11px] text-ink-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={
            'flex h-[30px] flex-1 items-center gap-2 rounded-md border px-2.5 text-left text-[12px] ' +
            (set
              ? 'border-accent bg-accent/15 font-mono text-ink'
              : 'border-card-strong bg-card text-ink-muted hover:text-ink')
          }
        >
          <span className="flex-1 truncate">
            {set ? value : mixed && mixed > 1 ? `mixed — ${mixed} values` : 'Leave as is'}
          </span>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {set && (
          <button
            type="button"
            aria-label={`Leave ${label.toLowerCase()} as is`}
            onClick={onClear}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
      <span className="text-[10.5px] leading-snug text-ink-muted">{help}</span>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-[52px] z-20 max-h-[240px] w-full overflow-y-auto rounded-lg border border-card-strong bg-surface-elevated py-1 shadow-xl">
            {options.length === 0 && <div className="px-3 py-2 text-[11px] text-ink-faint">{empty}</div>}
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onPick(option.value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-card-strong"
              >
                <span className={'flex-1 truncate text-[12px] text-ink ' + (option.mono ? 'font-mono' : '')}>
                  {option.label}
                </span>
                {option.note && <span className="text-[10.5px] text-ink-faint">{option.note}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProbeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="-mt-1.5 flex flex-col gap-1.5">
      <span className="text-[10.5px] text-ink-muted">{label}</span>
      <input
        className="field px-2 py-1.5 font-mono text-[11.5px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/// How many distinct values the selection holds, for the mixed state.
function mixedOf(values: readonly string[]): number {
  return new Set(values).size;
}

/// Where the selection stands now, in the header: the branches it spans, most
/// common first. What the old bar could only say as a count.
function summarise(services: readonly BulkService[]): string {
  const counts = new Map<string, number>();
  for (const service of services) {
    const ref = service.ref ?? 'no branch';
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ref, n]) => `${n} ${ref}`)
    .join(' · ');
}

function countLine(plan: { changing: number; unchanged: number; blocked: number }): string {
  const parts = [`${plan.changing} change`];
  if (plan.unchanged > 0) parts.push(`${plan.unchanged} already there`);
  if (plan.blocked > 0) parts.push(`${plan.blocked} cannot`);
  return parts.join(' · ');
}
