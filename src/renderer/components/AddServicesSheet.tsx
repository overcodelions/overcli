// Adding services: one sweep, one list, one decision.
//
// What this replaces: a scrolling wall of every project in the workspace, each
// with a "Look for services" button and an "Add by hand" button, with the
// import offers wedged in between the rows. Twenty-four projects meant
// twenty-four identical decisions before a single service appeared, and the
// files that actually know how these services are configured were buried
// among them.
//
// The sweep is cheap — it is a file walk and a few reads — so it happens
// without being asked, and the screen is a RESULT rather than a set of
// buttons. `addCandidates.ts` holds the ranking that result is sorted by.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ImportSet } from '@shared/servicesImport';
import type { ServiceProposal } from '@shared/services';
import { useServicesStore } from '../servicesStore';
import {
  buildCandidates,
  filterCandidates,
  planAdds,
  type CandidateGroup,
} from '../addCandidates';
import { AddServiceSheet, type AddTarget } from './AddServiceSheet';

export interface AddStack {
  id: string;
  name: string;
  projects: { id: string; name: string; path: string }[];
}

type Sweep = {
  imports: { stackId: string; projectId: string; projectName: string; sets: ImportSet[] }[];
  detected: {
    stackId: string;
    projectId: string;
    projectName: string;
    found: { projectId: string; serviceId: string; proposal: ServiceProposal }[];
  }[];
  projectCount: number;
};

export function AddServicesSheet({
  stacks,
  existing,
  onClose,
  standalone,
}: {
  stacks: AddStack[];
  existing: ReadonlySet<string>;
  onClose: () => void;
  /// True when this IS the pane — the first-run state, with nothing to go
  /// back to. It then renders without a backdrop or a close button.
  standalone?: boolean;
}) {
  const load = useServicesStore((s) => s.load);
  const loadMachine = useServicesStore((s) => s.loadMachine);
  const promptMachineNeeds = useServicesStore((s) => s.promptMachineNeeds);

  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [byHand, setByHand] = useState<AddTarget | null>(null);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const [needsCommand, setNeedsCommand] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const parts = await Promise.all(
        stacks.map(async (stack) => {
          const [sets, found] = await Promise.all([
            window.overcli.invoke('services:findImports', { projects: stack.projects }),
            window.overcli.invoke('services:scan', { projects: stack.projects }),
          ]);
          const named = (id: string) => stack.projects.find((p) => p.id === id)?.name ?? stack.name;
          // Detection answers for the whole stack at once; split it back per
          // project so each row can say which project it came from.
          const byProject = new Map<string, typeof found>();
          for (const item of found) {
            const list = byProject.get(item.projectId) ?? [];
            list.push(item);
            byProject.set(item.projectId, list);
          }
          return {
            imports: sets.map((entry) => ({
              stackId: stack.id,
              projectId: entry.projectId,
              projectName: named(entry.projectId),
              sets: entry.sets,
            })),
            detected: [...byProject.entries()].map(([projectId, items]) => ({
              stackId: stack.id,
              projectId,
              projectName: named(projectId),
              found: items,
            })),
            projectCount: stack.projects.length,
          };
        }),
      );
      if (cancelled) return;
      setSweep({
        imports: parts.flatMap((p) => p.imports),
        detected: parts.flatMap((p) => p.detected),
        projectCount: parts.reduce((n, p) => n + p.projectCount, 0),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [stacks]);

  const groups = useMemo(
    () =>
      sweep
        ? buildCandidates({ imports: sweep.imports, detected: sweep.detected, existing }).map(
            (g) => ({ ...g, items: g.items.filter((it) => !added.includes(it.key)) }),
          ).filter((g) => g.items.length > 0)
        : [],
    [sweep, existing, added],
  );

  // Nothing starts ticked. A workspace offers sixty services and nobody runs
  // sixty; unticking fifty-odd to keep the few you want is backwards.
  useEffect(() => {
    field.current?.focus();
  }, [sweep]);

  const shown = useMemo(() => filterCandidates(groups, query), [groups, query]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const count = picked.size;

  function toggle(key: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function importFromFile() {
    setFileError(null);
    const result = await window.overcli.invoke('services:importFile');
    if (!result) return;
    if ('error' in result) {
      setFileError(result.error);
      return;
    }
    // The project the file sits in, when it sits in one; otherwise the first
    // project, and the import resolves modules across the whole workspace.
    let home: { stack: AddStack; project: AddStack['projects'][number] } | undefined;
    for (const stack of stacks) {
      for (const project of stack.projects) {
        const inside = result.file.startsWith(project.path.replace(/\/?$/, '/'));
        if (inside && (!home || project.path.length > home.project.path.length)) home = { stack, project };
      }
    }
    home ??= stacks[0]?.projects[0] ? { stack: stacks[0], project: stacks[0].projects[0] } : undefined;
    if (!home) return;
    const entry = { stackId: home.stack.id, projectId: home.project.id, projectName: home.project.name, sets: [result.set] };
    setSweep((s) => (s ? { ...s, imports: [entry, ...s.imports] } : s));
    // Picking a file is saying you want what is in it.
    const prefix = `import:${home.stack.id}:${home.project.id}:${result.set.source}:${result.set.file}:`;
    setPicked((p) => new Set([...p, ...result.set.services.map((_, i) => `${prefix}${i}`)]));
  }

  async function addPicked() {
    setBusy(true);
    const notAdded: { name: string; reason: string }[] = [];
    const noCommand: string[] = [];
    try {
      const plan = planAdds(shown, picked);
      for (const entry of plan.imports) {
        const stack = stacks.find((s) => s.id === entry.stackId);
        const project = stack?.projects.find((p) => p.id === entry.projectId);
        if (!stack || !project) continue;
        const outcome = await window.overcli.invoke('services:import', {
          workspaceId: stack.id,
          projectId: project.id,
          projectPath: project.path,
          projectName: project.name,
          services: entry.services,
          siblings: stack.projects,
        });
        notAdded.push(...outcome.skipped);
        noCommand.push(...outcome.needsCommand);
      }
      for (const { stackId, item } of plan.detected) {
        const stack = stacks.find((s) => s.id === stackId);
        const project = stack?.projects.find((p) => p.id === item.projectId);
        await window.overcli.invoke('services:add', {
          workspaceId: stackId,
          spec: { ...item.proposal.spec, id: item.serviceId, projectId: item.projectId },
          binding: project ? { ref: 'HEAD', path: project.path } : undefined,
        });
      }
      for (const stack of stacks) await load(stack.id);
      await loadMachine();
      setAdded((a) => [...a, ...picked]);
      setPicked(new Set());
      setSkipped(notAdded);
      setNeedsCommand(noCommand);
      // A run configuration that says `${DB_PASSWORD}` needs a value before
      // anything can start. Ask now, while the user is setting up, rather
      // than letting the first Start fail with a list of names.
      // The sheet it opens lives on the pane, so closing this one is fine.
      await promptMachineNeeds(stacks.map((s) => s.id));
      // Stay open when something was left out or still needs a command:
      // closing would hide the only place that says so.
      if (!standalone && notAdded.length === 0 && noCommand.length === 0) onClose();
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="flex-shrink-0 border-b border-card px-5 pb-3 pt-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold">Add services</span>
          <span className="text-[11.5px] text-ink-faint">
            {sweep ? `${sweep.projectCount} project${sweep.projectCount === 1 ? '' : 's'}` : ''}
          </span>
          <div className="flex-1" />
          <span className="text-[11px] text-ink-faint">Nothing is added until you say so</span>
          {!standalone && (
            <button className="svc-btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <p className="mb-3 mt-1.5 max-w-[640px] text-[11.5px] leading-4 text-ink-muted">
          overcli read your run configurations first — those state the options — then worked out
          the rest from the build files. Pick what you want to run.
        </p>
        <input
          ref={field}
          className="w-full max-w-[420px] rounded-md border border-card-strong bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
          placeholder={total > 0 ? `Search ${total} services by name, module or project` : 'Search'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* results */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3.5">
        {sweep === null && (
          <div className="px-1 py-6 text-xs text-ink-muted">
            Looking through your projects for anything that starts…
          </div>
        )}

        {sweep !== null && total === 0 && (
          <div className="px-1 py-6 text-xs text-ink-muted">
            Nothing here starts on its own. Add one by hand and overcli will look after it the same
            way.
          </div>
        )}

        {shown.map((group) => (
          <Group
            key={group.id}
            group={group}
            picked={picked}
            onToggle={toggle}
            onAll={() => {
              const every = group.items.every((i) => picked.has(i.key));
              setPicked((p) => {
                const next = new Set(p);
                for (const i of group.items) {
                  if (every) next.delete(i.key);
                  else next.add(i.key);
                }
                return next;
              });
            }}
          />
        ))}

        {sweep !== null && query !== '' && shown.length === 0 && (
          <div className="px-1 py-6 text-xs text-ink-faint">Nothing matches “{query}”.</div>
        )}
        <div className="h-5" />
      </div>

      {/* footer */}
      <div className="flex flex-shrink-0 items-center gap-2.5 border-t border-card bg-surface-muted px-5 py-3">
        <button
          className="svc-btn"
          onClick={() =>
            setByHand({ stackId: stacks[0]?.id ?? '', projects: stacks[0]?.projects ?? [] })
          }
        >
          + Add one by hand
        </button>
        <button className="svc-btn" disabled={sweep === null} onClick={() => void importFromFile()}>
          Import from file…
        </button>
        {fileError && (
          <span className="min-w-0 truncate text-[11px] text-amber-700 dark:text-amber-300" title={fileError}>
            {fileError}
          </span>
        )}
        {(skipped.length > 0 || needsCommand.length > 0) && (
          <div className="flex min-w-0 flex-col text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {skipped.length > 0 && (
              <span
                className="truncate"
                title={skipped.map((s) => `${s.name}: ${s.reason}`).join('\n')}
              >
                {skipped.length} not added —{' '}
                {skipped
                  .slice(0, 2)
                  .map((s) => `${s.name} (${s.reason})`)
                  .join(', ')}
                {skipped.length > 2 ? '…' : ''}
              </span>
            )}
            {skipped.length > 0 && (
              <span className="truncate text-ink-muted">
                Add its folder to this workspace, or “+ Add one by hand” and point at the folder.
              </span>
            )}
            {needsCommand.length > 0 && (
              <span className="truncate" title={needsCommand.join(', ')}>
                {needsCommand.length} added without a command — set it under Settings:{' '}
                {needsCommand.slice(0, 3).join(', ')}
                {needsCommand.length > 3 ? '…' : ''}
              </span>
            )}
          </div>
        )}
        <div className="flex-1" />
        <span className="text-[11.5px] text-ink-muted">
          {count === 0 ? 'Nothing picked' : `${count} picked`}
        </span>
        <button className="svc-btn-primary" disabled={busy || count === 0} onClick={() => void addPicked()}>
          {busy ? 'Adding…' : count === 0 ? 'Add' : `Add ${count} service${count === 1 ? '' : 's'}`}
        </button>
      </div>

      {byHand && <AddServiceSheet target={byHand} onClose={() => setByHand(null)} />}
    </div>
  );

  if (standalone) return body;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[min(1040px,92vw)] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  );
}

/// One source of services, with what it is worth stated in its header.
function Group({
  group,
  picked,
  onToggle,
  onAll,
}: {
  group: CandidateGroup;
  picked: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onAll: () => void;
}) {
  const every = group.items.every((i) => picked.has(i.key));
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-card bg-card">
      <div className="flex items-center gap-2 border-b border-card bg-card px-3 py-2">
        <FileIcon stated={group.stated} />
        {group.projectName && <span className="text-xs font-semibold text-accent">{group.projectName}</span>}
        <span className="text-xs font-semibold">{group.title}</span>
        {group.file && <span className="font-mono text-[10px] text-ink-faint">{group.file}</span>}
        <span
          className={`rounded border px-1 py-px text-[9.5px] leading-none ${
            group.stated
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'border-card-strong text-ink-faint'
          }`}
        >
          {group.stated ? 'states the options' : 'a guess at how to start it'}
        </span>
        <div className="flex-1" />
        <span className="text-[10.5px] text-ink-faint">
          {group.stated ? '' : 'nothing here knows the options'}
        </span>
        <button className="svc-btn" onClick={onAll}>
          {every ? 'None' : 'All'}
        </button>
      </div>
      {group.items.map((item) => (
        <button
          key={item.key}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-card-strong"
          onClick={() => onToggle(item.key)}
        >
          <Box on={picked.has(item.key)} />
          <span className="w-[190px] truncate text-xs">{item.name}</span>
          <span className="w-[120px] truncate font-mono text-[10.5px] text-ink-faint">
            {/* Build-file guesses share one group across projects, so the
                row has to say which project; a config group says it above. */}
            {group.projectName ? (item.module ?? '') : item.projectName}
          </span>
          <span className="flex-1 truncate font-mono text-[10.5px] text-ink-faint">
            {item.command}
          </span>
          {item.port !== undefined && (
            <span className="font-mono text-[10.5px] text-[var(--c-link-file)]">:{item.port}</span>
          )}
          {item.uncertain && (
            <span className="rounded bg-amber-500/15 px-1 text-[9.5px] text-amber-700 dark:text-amber-300">
              worth a check
            </span>
          )}
          <span className="rounded border border-card-strong px-1 py-px text-[9.5px] leading-none text-ink-faint">
            {item.detail}
          </span>
        </button>
      ))}
    </div>
  );
}

function Box({ on }: { on: boolean }) {
  return (
    <span
      className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[3px] border ${
        on ? 'border-accent bg-accent' : 'border-card-strong'
      }`}
    >
      {on && (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--c-surface)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function FileIcon({ stated }: { stated: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={stated ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-faint'}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
