// Share a stack, and import one someone shared.
//
// The file in between is `shared/stackShare.ts`; what these sheets add is
// saying, before anything leaves or arrives, what the file holds and what it
// does not. A teammate who imports forty services and finds three missing
// should already have been told which three and why.

import { useEffect, useMemo, useState } from 'react';
import type { ServiceSpec } from '@shared/services';
import type { SharePreview, SharedRepoMatch, SharedStack } from '@shared/stackShare';
import { useServicesStore } from '../servicesStore';
import type { AddStack } from './AddServicesSheet';

function Frame({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex h-[min(720px,calc(100vh-64px))] w-[min(720px,calc(100vw-64px))] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start gap-3 border-b border-card px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">{title}</div>
            {subtitle && <div className="mt-1 truncate text-[11.5px] text-ink-muted">{subtitle}</div>}
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-card bg-surface-muted px-5 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{children}</div>;
}

function StackPicker({
  stacks,
  value,
  onChange,
  label,
}: {
  stacks: AddStack[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  if (stacks.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-card-strong bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
      >
        {stacks.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── share ───────────────────────────────────────────────────────────────────

/// A checkbox that can also say "some of these".
function Tick({ on, mixed, label, onClick }: { on: boolean; mixed?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on ? true : mixed ? 'mixed' : false}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[3px] border ' +
        (on || mixed ? 'border-accent bg-accent' : 'border-card-strong hover:border-ink-faint')
      }
    >
      {on ? (
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="var(--c-surface)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.2 3L13 4.5" />
        </svg>
      ) : mixed ? (
        <span className="h-[1.5px] w-[7px] bg-[var(--c-surface)]" />
      ) : null}
    </button>
  );
}

function Toggle({ on, onClick, title, detail }: { on: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className="flex items-start gap-3 rounded-md border border-card px-3 py-2.5 text-left hover:border-card-strong"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] text-ink">{title}</span>
        <span className="text-[11.5px] leading-4 text-ink-muted">{detail}</span>
      </span>
      <span className={'relative mt-0.5 h-[18px] w-[30px] flex-shrink-0 rounded-full ' + (on ? 'bg-accent' : 'bg-card-strong')}>
        <span className={'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-[left] ' + (on ? 'left-[14px]' : 'left-[2px]')} />
      </span>
    </button>
  );
}

const VALUES_SHOWN = 14;

export function ShareStackSheet({
  stacks,
  selection,
  onClose,
}: {
  /// Only stacks with services.
  stacks: AddStack[];
  /// The ticked rows, when Share came from the selection bar.
  selection?: { workspaceId: string; serviceIds: string[] };
  onClose: () => void;
}) {
  const views = useServicesStore((s) => s.stacks);
  const machine = useServicesStore((s) => s.machine);
  const [workspaceId, setWorkspaceId] = useState(selection?.workspaceId ?? stacks[0]?.id ?? '');
  const stack = stacks.find((s) => s.id === workspaceId);
  const view = views[workspaceId];
  const services = useMemo(() => view?.services ?? [], [view]);

  // Tasks start unticked: a publish to Maven local is how YOU build, and the
  // person importing usually wants the services, not your build steps.
  const initialPick = (id: string) =>
    new Set(
      selection?.workspaceId === id
        ? selection.serviceIds
        : (views[id]?.services ?? []).filter((s) => !s.task).map((s) => s.id),
    );
  const [picked, setPicked] = useState<Set<string>>(() => initialPick(workspaceId));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [includePins, setIncludePins] = useState(false);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [allValues, setAllValues] = useState(false);
  const [showFile, setShowFile] = useState(false);

  const repoOf = useMemo(() => {
    const names = new Map(stack?.projects.map((p) => [p.id, p.name]) ?? []);
    return (spec: ServiceSpec) =>
      (spec.projectId && names.get(spec.projectId)) ||
      view?.bindings.find((b) => b.serviceId === spec.id)?.path.split('/').filter(Boolean).pop() ||
      '';
  }, [stack, view]);

  const groups = useMemo(() => {
    const out: { name: string; specs: ServiceSpec[] }[] = [];
    for (const spec of services) {
      const name = spec.group?.trim() || 'Other';
      let group = out.find((g) => g.name === name);
      if (!group) out.push((group = { name, specs: [] }));
      group.specs.push(spec);
    }
    return out;
  }, [services]);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? groups
        .map((g) => ({ ...g, specs: g.specs.filter((s) => s.name.toLowerCase().includes(needle) || repoOf(s).toLowerCase().includes(needle)) }))
        .filter((g) => g.specs.length > 0)
    : groups;

  const pickedKey = [...picked].sort().join('\n');
  useEffect(() => {
    if (!stack || picked.size === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setSaid(null);
    // Ticking through a group fires a burst of changes; ask once it settles.
    const timer = setTimeout(() => {
      window.overcli
        .invoke('services:shareStack', {
          workspaceId,
          name: stack.name,
          projects: stack.projects,
          serviceIds: [...picked],
          includePins,
        })
        .then((p) => !cancelled && (setPreview(p), setError(null)))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `pickedKey` is what `picked` holds; the Set itself is new on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, pickedKey, includePins, stack]);

  const setMany = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const toggleOpen = (name: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const chosen = services.filter((s) => picked.has(s.id));
  const pins = chosen.filter((s) => s.pinnedRef).length;
  const configFiles = chosen.filter(
    (s) =>
      Object.keys(s.config.link ?? {}).length + Object.keys(s.config.render ?? {}).length > 0 ||
      Object.values(s.config.inject ?? {}).some((v) => v.includes('${SERVICE_CONFIG_DIR}')),
  ).length;
  const sharedCount = preview?.stack.services.length ?? 0;
  const bases = sharedCount - picked.size;
  const repoCount = preview ? Object.keys(preview.stack.repos).length : 0;
  const values = preview?.stack.values ?? [];
  const blanked = preview?.scrubbed ?? [];
  const blankNames = new Set(blanked.map((b) => b.name));
  const mine = values.filter((name) => !blankNames.has(name));
  const definedHere = new Set(machine.map((e) => e.name));
  const secretHere = new Set(machine.filter((e) => e.secret).map((e) => e.name));
  const fileName = `${(preview?.stack.name ?? stack?.name ?? 'stack').replace(/[^A-Za-z0-9_-]+/g, '-')}.overcli-stack.json`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex h-[min(880px,calc(100vh-48px))] w-[min(1240px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start gap-3 border-b border-card px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">Share stack</div>
            <div className="mt-1 text-[11.5px] text-ink-muted">
              Pick what a teammate should be able to run. Your values and secrets never leave this Mac.
            </div>
          </div>
          <StackPicker
            stacks={stacks}
            value={workspaceId}
            onChange={(id) => {
              setWorkspaceId(id);
              setPicked(initialPick(id));
              setOpen(new Set());
            }}
            label="Stack"
          />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Not flex-wrap: a wrapping row is as tall as its content, so neither
            column scrolled and the bottom of a long list was cut off. */}
        <div className="flex min-h-0 flex-1">
          {/* the picker */}
          <div className="flex min-h-0 w-[44%] min-w-[300px] flex-shrink-0 flex-col border-r border-card bg-surface-muted">
            <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
              <input
                className="h-[28px] min-w-0 flex-1 rounded-md border border-card-strong bg-surface px-2.5 text-[12px] outline-none focus:border-accent"
                placeholder="Filter services"
                aria-label="Filter services"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" className="svc-btn" onClick={() => setMany(services.map((s) => s.id), true)}>
                All
              </button>
              <button type="button" className="svc-btn" onClick={() => setMany(services.map((s) => s.id), false)}>
                None
              </button>
            </div>
            <div className="px-3.5 pb-2 text-[11px] text-ink-muted">
              {picked.size} of {services.length} selected
              {services.some((s) => s.task) && ' · tasks start unticked'}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              {shown.map((group) => {
                const ids = group.specs.map((s) => s.id);
                const count = ids.filter((id) => picked.has(id)).length;
                const expanded = needle !== '' || open.has(group.name);
                return (
                  <div key={group.name}>
                    <div className="flex h-[30px] items-center gap-2 pl-2 pr-3.5">
                      <button
                        type="button"
                        aria-label={`${expanded ? 'Hide' : 'Show'} ${group.name}`}
                        aria-expanded={expanded}
                        onClick={() => toggleOpen(group.name)}
                        className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:text-ink"
                      >
                        <Chevron open={expanded} />
                      </button>
                      <Tick
                        on={count === ids.length}
                        mixed={count > 0}
                        label={`Share all of ${group.name}`}
                        onClick={() => setMany(ids, count !== ids.length)}
                      />
                      <button
                        type="button"
                        onClick={() => toggleOpen(group.name)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink">
                          {group.name}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-muted">
                          {count}/{ids.length}
                        </span>
                      </button>
                    </div>
                    {expanded &&
                      group.specs.map((spec) => {
                        const on = picked.has(spec.id);
                        return (
                          <label
                            key={spec.id}
                            className={
                              'flex h-[28px] cursor-pointer items-center gap-2.5 pl-[34px] pr-3.5 hover:bg-card-strong ' +
                              (on ? 'bg-accent/[0.06]' : '')
                            }
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setMany([spec.id], !on)}
                              className="h-3.5 w-3.5 flex-shrink-0 accent-[var(--c-accent)]"
                            />
                            <span className={'min-w-0 flex-1 truncate text-[12.5px] ' + (on ? 'text-ink' : 'text-ink-muted')}>
                              {spec.name}
                            </span>
                            {spec.task && <span className="rounded bg-card-strong px-1 text-[10px] text-ink-faint">once</span>}
                            <span className="max-w-[40%] truncate font-mono text-[10.5px] text-ink-faint">{repoOf(spec)}</span>
                          </label>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* what they get */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
            {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}

            <div className="flex flex-col gap-1">
              <Label>They get</Label>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[26px] font-semibold tracking-tight text-ink">{sharedCount}</span>
                <span className="text-[13px] text-ink-muted">services from</span>
                <span className="text-[26px] font-semibold tracking-tight text-ink">{repoCount}</span>
                <span className="text-[13px] text-ink-muted">repos</span>
              </div>
              <span className="text-[12px] leading-4 text-ink-muted">
                Commands, groups, start order, ports, ready checks and options. Repos are found by git remote on their
                machine.
                {bases > 0 && ` Includes ${bases} base service${bases === 1 ? '' : 's'} the copies you picked are built on.`}
              </span>
            </div>

            {values.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="flex items-baseline gap-2">
                  <Label>They fill in</Label>
                  <span className="text-[12px] text-ink">{values.length} values · names only, never what you have</span>
                </div>

                {mine.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-ink">
                      Your machine values · {mine.length}
                      <span className="text-ink-muted"> — your services already refer to these by name</span>
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {(allValues ? mine : mine.slice(0, VALUES_SHOWN)).map((name) => (
                        <span
                          key={name}
                          title={
                            secretHere.has(name)
                              ? 'A secret, kept in your keychain'
                              : definedHere.has(name)
                                ? 'A machine value on this Mac'
                                : 'Referred to, but not set on this Mac either'
                          }
                          className={
                            'flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] ' +
                            (definedHere.has(name) ? 'bg-card-strong text-ink' : 'border border-dashed border-card-strong text-ink-muted')
                          }
                        >
                          {secretHere.has(name) && <LockGlyph />}
                          {name}
                        </span>
                      ))}
                      {mine.length > VALUES_SHOWN && (
                        <button
                          type="button"
                          onClick={() => setAllValues((v) => !v)}
                          className="px-1.5 text-[11px] text-accent hover:underline"
                        >
                          {allValues ? 'fewer' : `+${mine.length - VALUES_SHOWN} more`}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {blanked.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-ink">
                      Typed into a service, now blank · {blanked.length}
                      <span className="text-ink-muted">
                        {' '}
                        — the key reads like a credential, so its value was taken out
                      </span>
                    </span>
                    <div className="flex flex-col overflow-hidden rounded-md border border-amber-500/30">
                      {blanked.map((b) => (
                        <div
                          key={b.name}
                          className="flex min-h-[28px] flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-1 first:border-t-0"
                        >
                          <span className="font-mono text-[10.5px] text-amber-700 dark:text-amber-300">{b.name}</span>
                          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-ink-muted" title={b.from.map((f) => `${f.service}: ${f.key}`).join('\n')}>
                            {b.from[0].service} · {b.from[0].key}
                            {b.from.length > 1 && ` +${b.from.length - 1}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label>Also include</Label>
              <Toggle
                on={includePins}
                onClick={() => setIncludePins((v) => !v)}
                title="Branch pins"
                detail={
                  pins === 0
                    ? 'None of these is pinned to a branch.'
                    : `${pins} pinned to a branch. Off: they follow whatever branch each clone is on.`
                }
              />
              {configFiles > 0 && (
                <div className="rounded-md border border-dashed border-card px-3 py-2.5 text-[11.5px] leading-4 text-ink-muted">
                  <span className="text-ink">Local config files are not included yet.</span> {configFiles} of these read
                  files from their config folder; the teammate adds their own.
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-muted">
                Never included: your folder paths, branches, running state and logs.
              </span>
              {preview && (
                <button
                  type="button"
                  onClick={() => setShowFile((v) => !v)}
                  className="self-start text-[12px] text-accent hover:underline"
                >
                  {showFile ? 'Hide the file' : 'View the file'}
                </button>
              )}
              {showFile && preview && (
                <pre className="max-h-[220px] overflow-auto rounded-md border border-card bg-surface p-3 font-mono text-[10.5px] leading-[1.5] text-ink-muted">
                  {preview.text}
                </pre>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-card bg-surface-muted px-5 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">{said ?? fileName}</span>
          <button
            type="button"
            className="svc-btn"
            disabled={!preview}
            onClick={() =>
              preview &&
              void navigator.clipboard.writeText(preview.text).then(() => setSaid('Copied to the clipboard.'))
            }
          >
            Copy
          </button>
          <button
            type="button"
            disabled={!preview}
            onClick={() =>
              preview &&
              void window.overcli
                .invoke('services:saveShare', { text: preview.text, name: preview.stack.name })
                .then((saved) => saved && setSaid(`Saved ${sharedCount} services.`))
            }
            className="h-[26px] rounded-md bg-accent px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {picked.size === 0 ? 'Pick something to share' : `Save ${sharedCount || picked.size} services…`}
          </button>
        </div>
      </div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      className={'transition-transform ' + (open ? 'rotate-90' : '')}
    >
      <path d="M3 2l3 3-3 3" />
    </svg>
  );
}

// ── import ──────────────────────────────────────────────────────────────────

export function ImportStackSheet({ stacks, onClose }: { stacks: AddStack[]; onClose: () => void }) {
  const load = useServicesStore((s) => s.load);
  const loadMachine = useServicesStore((s) => s.loadMachine);
  const promptMachineNeeds = useServicesStore((s) => s.promptMachineNeeds);

  const [incoming, setIncoming] = useState<{ file: string; stack: SharedStack } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(stacks[0]?.id ?? '');
  const [matches, setMatches] = useState<SharedRepoMatch[]>([]);
  const [places, setPlaces] = useState<Record<string, { projectId?: string; path: string } | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);

  const projects = useMemo(() => {
    const seen = new Map<string, AddStack['projects'][number]>();
    for (const s of stacks) for (const p of s.projects) seen.set(p.id, p);
    return [...seen.values()];
  }, [stacks]);

  async function pickFile() {
    const result = await window.overcli.invoke('services:readShared');
    if (!result) {
      if (!incoming) onClose();
      return;
    }
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setSkipped([]);
    setIncoming(result);
    const found = await window.overcli.invoke('services:matchShared', { stack: result.stack, projects });
    setMatches(found);
    setPlaces(Object.fromEntries(found.map((m) => [m.key, m.match])));
  }

  useEffect(() => {
    void pickFile();
    // Once, on open: the sheet IS the answer to "which file".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFolder(match: SharedRepoMatch) {
    const folder = await window.overcli.invoke('services:pickFolder', {
      title: `Where is ${match.repo.name}?`,
    });
    if (!folder) return;
    // A folder that is one of the projects keeps that project's id, so the
    // service is listed under it like any other.
    const project = projects.find((p) => p.path === folder);
    setPlaces((p) => ({ ...p, [match.key]: { projectId: project?.id, path: folder } }));
  }

  const placed = matches.filter((m) => places[m.key]);
  const count = matches.reduce((n, m) => n + (places[m.key] ? m.services : 0), 0);

  async function add() {
    if (!incoming) return;
    setBusy(true);
    try {
      const outcome = await window.overcli.invoke('services:importShared', {
        workspaceId,
        stack: incoming.stack,
        places,
      });
      await load(workspaceId);
      await loadMachine();
      setSkipped(outcome.skipped);
      // The values only the importer has. Asked now, while they are setting
      // up, not by the first Start failing with a list of names.
      await promptMachineNeeds([workspaceId]);
      if (outcome.skipped.length === 0) onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      title="Import a shared stack"
      subtitle={
        incoming
          ? `${incoming.stack.name} · ${incoming.stack.services.length} services from ${matches.length} repos`
          : 'Pick the file a teammate shared'
      }
      onClose={onClose}
      footer={
        <>
          <span
            className="min-w-0 flex-1 truncate text-[11.5px] text-amber-700 dark:text-amber-300"
            title={skipped.map((s) => `${s.name}: ${s.reason}`).join('\n')}
          >
            {skipped.length > 0
              ? `${skipped.length} not added — ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`
              : ''}
          </span>
          <button type="button" className="svc-btn" onClick={() => void pickFile()}>
            Other file…
          </button>
          <button
            type="button"
            disabled={!incoming || count === 0 || busy}
            onClick={() => void add()}
            className="h-[26px] rounded-md bg-accent px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Adding…' : `Add ${count} service${count === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
      {incoming && (
        <>
          <StackPicker stacks={stacks} value={workspaceId} onChange={setWorkspaceId} label="Add to" />

          <div className="flex flex-col gap-1.5">
            <Label>
              Repos · {placed.length} of {matches.length} found
            </Label>
            <div className="overflow-hidden rounded-md border border-card">
              {matches.map((m) => {
                const place = places[m.key];
                return (
                  <div key={m.key} className="flex min-h-[36px] items-center gap-2.5 border-t border-card px-3 py-1 first:border-t-0">
                    <span
                      aria-hidden
                      className={
                        'h-1.5 w-1.5 flex-shrink-0 rounded-full ' +
                        (place ? 'bg-green-500 dark:bg-green-400' : 'border border-amber-500 dark:border-amber-400')
                      }
                    />
                    <span className="w-[140px] flex-shrink-0 truncate font-mono text-[11.5px] text-ink" title={m.repo.remote}>
                      {m.repo.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted" title={place?.path ?? m.repo.remote}>
                      {place ? place.path : `not found${m.repo.remote ? ` — clone ${m.repo.remote}` : ''}`}
                    </span>
                    <span className="flex-shrink-0 text-[11px] text-ink-faint">
                      {m.services} service{m.services === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="svc-btn" onClick={() => void pickFolder(m)}>
                      {place ? 'Change…' : 'Pick folder…'}
                    </button>
                    {place && (
                      <button
                        type="button"
                        aria-label={`Skip ${m.repo.name}`}
                        title="Skip this repo"
                        onClick={() => setPlaces((p) => ({ ...p, [m.key]: undefined }))}
                        className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-card-strong hover:text-ink"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {placed.length < matches.length && (
              <div className="text-[11.5px] text-ink-muted">
                Services in a repo without a folder are left out. Clone it and pick the folder, or add them later.
              </div>
            )}
          </div>

          {incoming.stack.values.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>Values only you have · {incoming.stack.values.length}</Label>
              <div className="flex flex-wrap gap-1">
                {incoming.stack.values.map((name) => (
                  <span key={name} className="rounded bg-card-strong px-1.5 py-0.5 font-mono text-[10.5px] text-ink">
                    {name}
                  </span>
                ))}
              </div>
              <div className="text-[11.5px] text-ink-muted">
                Any you have not set yet are asked for right after adding. They go in your machine values, secrets in
                the keychain.
              </div>
            </div>
          )}

          <div className="text-[11.5px] text-ink-muted">
            Everything is added stopped, on whatever branch each folder is on. A port another stack already holds is
            offered an offset when you start.
          </div>
        </>
      )}
    </Frame>
  );
}
