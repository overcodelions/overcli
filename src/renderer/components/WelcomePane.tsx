import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Composer } from './Composer';
import { Backend, PermissionMode, EffortLevel, Project, UUID, Attachment, Workspace } from '@shared/types';
import { backendColor, backendName, shortModel } from '../theme';
import { useSlashCommands } from '../hooks';

const WELCOME_KEY = '__welcome__';

/// Composer-first start page. Modeled on the reference screenshot the user
/// shared: a centered prompt + big input, with pills for model/effort/mode
/// inside the composer and project/env/branch below it. Sending from here
/// creates a new conversation and hands the draft + attachments off.
export function WelcomePane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const settings = useStore((s) => s.settings);
  const focusedProjectId = useStore((s) => s.focusedProjectId);
  const focusedWorkspaceId = useStore((s) => s.focusedWorkspaceId);
  const pickProject = useStore((s) => s.pickProject);
  const newConversation = useStore((s) => s.newConversation);
  const newConversationInWorkspace = useStore((s) => s.newConversationInWorkspace);
  const send = useStore((s) => s.send);
  const setBackendModel = useStore((s) => s.setBackendModel);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const setEffortLevel = useStore((s) => s.setEffortLevel);
  const setPrimaryBackend = useStore((s) => s.setPrimaryBackend);
  const addAttachment = useStore((s) => s.addAttachment);
  const clearAttachments = useStore((s) => s.clearAttachments);
  const setDraft = useStore((s) => s.setDraft);

  const focusedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === focusedWorkspaceId) ?? null,
    [workspaces, focusedWorkspaceId],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<UUID | null>(
    () => focusedProjectId ?? projects[0]?.id ?? null,
  );
  const [backend, setBackend] = useState<Backend>(() => firstEnabledBackend(settings));
  const [permissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings.defaultPermissionMode,
  );
  const [effort, setEffort] = useState<EffortLevel>(settings.defaultEffort);
  const [model, setModel] = useState<string>('');
  const [branch, setBranch] = useState<string>('');
  const [ollamaPulledModels, setOllamaPulledModels] = useState<string[]>([]);
  const slashCommands = useSlashCommands(backend);

  // When Ollama is the chosen backend, pull the list of installed models
  // from the local server so the model dropdown shows real options
  // instead of hardcoded guesses. Also auto-pick a default so users
  // don't have to open the dropdown: prefer the configured default if
  // they set one, else the first pulled model.
  useEffect(() => {
    if (backend !== 'ollama') return;
    let cancelled = false;
    void window.overcli.invoke('ollama:detect').then((det) => {
      if (cancelled) return;
      const names = det.models.map((m) => m.name);
      setOllamaPulledModels(names);
      setModel((current) => {
        if (current && names.includes(current)) return current;
        const configured = settings.backendDefaultModels.ollama;
        if (configured && names.includes(configured)) return configured;
        return names[0] ?? '';
      });
    });
    return () => {
      cancelled = true;
    };
  }, [backend, settings.backendDefaultModels.ollama]);

  // When projects arrive after init, snap the selection to the first one.
  useEffect(() => {
    if (!selectedProjectId && projects[0]) setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId]);

  // If the sidebar "+" was clicked on a different project while this pane
  // is already mounted, follow that intent.
  useEffect(() => {
    if (focusedProjectId) setSelectedProjectId(focusedProjectId);
  }, [focusedProjectId]);

  useEffect(() => {
    if (isBackendEnabled(settings, backend)) return;
    setBackend(firstEnabledBackend(settings));
  }, [settings, backend]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  // Resolve current branch for the selected project once we know which one
  // the user picked. Cheap — one git command — and updates reactively.
  useEffect(() => {
    if (!selectedProject) return;
    let cancelled = false;
    window.overcli
      .invoke('git:run', { args: ['branch', '--show-current'], cwd: selectedProject.path })
      .then((res) => {
        if (cancelled) return;
        const name = res.stdout.trim();
        setBranch(name || 'main');
      })
      .catch(() => setBranch('main'));
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  const handleSend = async (prompt: string, attachments: Attachment[]) => {
    const conv = focusedWorkspace
      ? await newConversationInWorkspace(focusedWorkspace.id)
      : selectedProject
      ? await newConversation(selectedProject.id)
      : null;
    if (!conv) return;
    // Move any welcome-key attachments to the new conversation's key.
    clearAttachments(conv.id);
    for (const a of attachments) addAttachment(conv.id, a);
    // Apply the pill selections as the conversation's initial settings.
    // These setters update in-memory state synchronously (via
    // `mutateConversation`) and only `await` the disk persistence step —
    // awaiting them here would defer `send` by several IPC roundtrips,
    // during which the freshly-selected conversation renders `NewAgentIntro`
    // with empty events before `send`'s optimistic user bubble lands. Fire
    // them without awaiting so the state is ready for `send` this tick.
    void setPrimaryBackend(conv.id, backend);
    void setPermissionMode(conv.id, permissionMode);
    if (effort) void setEffortLevel(conv.id, effort);
    if (model) void setBackendModel(conv.id, backend, model);
    // Fire the send. store.send reads draft+attachments from the store so
    // we explicitly cleared ours above and passed attachments through.
    setDraft(WELCOME_KEY, '');
    clearAttachments(WELCOME_KEY);
    await send(conv.id, prompt);
  };

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md w-full text-center">
          <div className="text-2xl font-semibold mb-1">OverCLI</div>
          <div className="text-sm text-ink-muted mb-6">
            GUI around the Claude, Codex, and Gemini CLIs. Add your first project to start.
          </div>
          <button
            onClick={pickProject}
            className="px-4 py-2 rounded-md bg-accent/30 text-accent hover:bg-accent/40 text-sm"
          >
            Choose a folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-[680px]">
        <div className="text-center text-2xl font-semibold mb-5">
          What should we build in {focusedWorkspace?.name ?? selectedProject?.name ?? 'OverCLI'}?
        </div>
        <Composer
          draftKey={WELCOME_KEY}
          autoFocus
          variant="welcome"
          rootPath={selectedProject?.path}
          slashCommands={slashCommands}
          placeholder={`Ask ${backendName(backend)} anything. @ to reference files · / for commands`}
          onSend={handleSend}
          footer={
            <>
              <Pill
                label={modeLabel(permissionMode)}
                color={permissionToneColor(permissionMode)}
                items={(['plan', 'default', 'acceptEdits', 'bypassPermissions'] as PermissionMode[]).map((m) => ({
                  value: m,
                  label: modeLabel(m),
                }))}
                onPick={(v) => setLocalPermissionMode(v as PermissionMode)}
              />
              <Pill
                label={backendName(backend)}
                color={backendColor(backend)}
                items={enabledBackends(settings).map((b) => ({
                  value: b,
                  label: backendName(b),
                }))}
                onPick={(v) => setBackend(v as Backend)}
              />
              <Pill
                label={model ? shortModel(model) : 'Model'}
                items={modelOptionsFor(
                  backend,
                  settings.backendDefaultModels[backend],
                  ollamaPulledModels,
                ).map((m) => ({
                  value: m,
                  label: shortModel(m),
                }))}
                onPick={(v) => setModel(v)}
              />
              {backend === 'claude' && (
                <Pill
                  label={effortLabel(effort)}
                  items={([
                    { value: '' as EffortLevel, label: 'Default' },
                    { value: 'low' as EffortLevel, label: 'Low' },
                    { value: 'medium' as EffortLevel, label: 'Medium' },
                    { value: 'high' as EffortLevel, label: 'High' },
                    { value: 'max' as EffortLevel, label: 'Max' },
                  ]).map((o) => ({ value: o.value, label: o.label }))}
                  onPick={(v) => setEffort(v as EffortLevel)}
                />
              )}
            </>
          }
        />
        <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted justify-center flex-wrap">
          {focusedWorkspace ? (
            <WorkspacePill workspace={focusedWorkspace} projects={projects} />
          ) : (
            <ProjectPill
              project={selectedProject}
              projects={projects}
              onPick={setSelectedProjectId}
              onAdd={pickProject}
            />
          )}
          <Pill label="Work locally" items={[{ value: 'local', label: 'Work locally' }]} onPick={() => {}} />
          {!focusedWorkspace && branch && (
            <Pill label={branch} items={[{ value: branch, label: branch }]} onPick={() => {}} />
          )}
        </div>
      </div>
    </div>
  );
}

function isBackendEnabled(settings: { disabledBackends?: Partial<Record<Backend, boolean>> }, backend: Backend): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

function enabledBackends(settings: { disabledBackends?: Partial<Record<Backend, boolean>> }): Backend[] {
  const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  return all.filter((b) => isBackendEnabled(settings, b));
}

function firstEnabledBackend(settings: { disabledBackends?: Partial<Record<Backend, boolean>> }): Backend {
  return enabledBackends(settings)[0] ?? 'claude';
}

function WorkspacePill({
  workspace,
  projects,
}: {
  workspace: Workspace;
  projects: Project[];
}) {
  const members = workspace.projectIds
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);
  return (
    <Pill
      label={workspace.name}
      items={members.map((p) => ({ value: p.id, label: p.name, note: shortPath(p.path) }))}
      onPick={() => {}}
    />
  );
}

function ProjectPill({
  project,
  projects,
  onPick,
  onAdd,
}: {
  project: Project | null;
  projects: Project[];
  onPick: (id: UUID) => void;
  onAdd: () => void;
}) {
  return (
    <Pill
      label={project?.name ?? 'Pick project'}
      items={[
        ...projects.map((p) => ({ value: p.id, label: p.name, note: shortPath(p.path) })),
        { value: '__add__', label: '+ Add project…' },
      ]}
      onPick={(v) => {
        if (v === '__add__') onAdd();
        else onPick(v as UUID);
      }}
    />
  );
}

function shortPath(p: string): string {
  // We don't have $HOME in the renderer (contextIsolation), so just
  // collapse any /Users/<anything>/ prefix to ~/ as a best-effort.
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'acceptEdits':
      return 'Accept edits';
    case 'bypassPermissions':
      return 'Full access';
    default:
      return 'Default';
  }
}

function permissionToneColor(mode: PermissionMode): string | undefined {
  if (mode === 'bypassPermissions' || mode === 'acceptEdits') return '#f97a5a'; // warm amber
  return undefined;
}

function effortLabel(effort: EffortLevel): string {
  if (!effort) return 'Effort';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/// Best-effort model suggestions per backend. The real CLI accepts any
/// model identifier it knows about — this is just a convenience dropdown.
/// Ollama is special-cased: we only show models that are actually pulled
/// locally, since the server will reject anything else.
function modelOptionsFor(
  backend: Backend,
  configuredDefault?: string,
  ollamaPulled?: string[],
): string[] {
  if (backend === 'ollama') {
    const list = ollamaPulled ?? [];
    if (configuredDefault && !list.includes(configuredDefault)) {
      return [configuredDefault, ...list];
    }
    return list;
  }
  const base: Record<Exclude<Backend, 'ollama'>, string[]> = {
    claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    codex: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  };
  const list = base[backend];
  if (configuredDefault && !list.includes(configuredDefault)) {
    return [configuredDefault, ...list];
  }
  return list;
}

interface PillItem {
  value: string;
  label: string;
  note?: string;
}

function Pill({
  label,
  items,
  onPick,
  color,
}: {
  label: string;
  items: PillItem[];
  onPick: (v: string) => void;
  color?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card-strong border border-card hover:bg-card-strong text-xs"
        style={color ? { color } : undefined}
      >
        <span>{label}</span>
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[200px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 py-1">
          {items.map((it) => (
            <button
              key={it.value}
              onClick={() => {
                setOpen(false);
                onPick(it.value);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
            >
              <div>{it.label}</div>
              {it.note && <div className="text-[10px] text-ink-faint truncate">{it.note}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
