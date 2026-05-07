import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Composer } from './Composer';
import { Backend, PermissionMode, EffortLevel, Project, UUID, Attachment, Workspace } from '@shared/types';
import { backendColor, backendName, shortModel } from '../theme';
import { useSlashCommands } from '../hooks';
import { modeLabel, permissionTone } from './conversationHeaderHelpers';

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
  const welcomeFocusToken = useStore((s) => s.welcomeFocusToken);
  const pickProject = useStore((s) => s.pickProject);
  const newConversation = useStore((s) => s.newConversation);
  const newConversationInWorkspace = useStore((s) => s.newConversationInWorkspace);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const startNewConversationInWorkspace = useStore((s) => s.startNewConversationInWorkspace);
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
  // Local nudge added to the global welcomeFocusToken so we can re-focus
  // the composer after the user clicks a starter prompt chip without
  // mutating store-level state.
  const [composerFocusNudge, setComposerFocusNudge] = useState(0);
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
  // `false` once probed and the folder isn't a git repo. We use this to
  // reframe the welcome screen as a "work folder" — review data, build
  // reports, investigate — rather than the build/code framing that fits a
  // git project. `true`/`undefined` keep the default coding framing.
  const projectIsGitRepo = useStore((s) => s.projectIsGitRepo);
  const isNonGitProject = !focusedWorkspace && !!selectedProject && projectIsGitRepo[selectedProject.id] === false;

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
    return <EmptyWelcome onPick={pickProject} />;
  }

  const headline = isNonGitProject
    ? `What can we dig into in ${selectedProject?.name}?`
    : `What should we build in ${focusedWorkspace?.name ?? selectedProject?.name ?? 'overcli'}?`;
  const placeholder = isNonGitProject
    ? `Review data, draft a report, investigate — ask ${backendName(backend)} anything. @ to reference files · / for commands`
    : `Ask ${backendName(backend)} anything. @ to reference files · / for commands`;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-[680px]">
        <div className="text-center text-2xl font-semibold mb-5">{headline}</div>
        {isNonGitProject && selectedProject && (
          <StarterPrompts
            project={selectedProject}
            onPick={(text) => {
              setDraft(WELCOME_KEY, text);
              setComposerFocusNudge((n) => n + 1);
            }}
          />
        )}
        <Composer
          draftKey={WELCOME_KEY}
          autoFocus
          focusSignal={welcomeFocusToken + composerFocusNudge}
          variant="welcome"
          rootPath={selectedProject?.path}
          slashCommands={slashCommands}
          placeholder={placeholder}
          onSend={handleSend}
          footer={
            <>
              <Pill
                label={modeLabel(permissionMode)}
                color={permissionTone(permissionMode)}
                items={(['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'] as PermissionMode[])
                  .filter((m) => m !== 'auto' || backend === 'claude')
                  .map((m) => ({
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
                onPick={(v) => {
                  const next = v as Backend;
                  setBackend(next);
                  // `auto` is Claude-only; demote to default when leaving Claude
                  // so the picker label and the eventual mapped behaviour agree.
                  if (next !== 'claude' && permissionMode === 'auto') {
                    setLocalPermissionMode('default');
                  }
                }}
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
          <ContextPill
            label={focusedWorkspace?.name ?? selectedProject?.name ?? 'Pick project'}
            projects={projects}
            workspaces={workspaces}
            onPickProject={(id) => startNewConversation(id)}
            onPickWorkspace={(id) => startNewConversationInWorkspace(id)}
            onAdd={pickProject}
          />
          <Pill label="Work locally" items={[{ value: 'local', label: 'Work locally' }]} onPick={() => {}} />
          {!focusedWorkspace && !isNonGitProject && branch && (
            <Pill label={branch} items={[{ value: branch, label: branch }]} onPick={() => {}} />
          )}
        </div>
      </div>
    </div>
  );
}

/// Quick-start chips shown above the composer for non-git "work folder"
/// projects. They prefill the draft so the user can edit before sending,
/// and frame the project as a place to investigate / report rather than
/// a codebase to build in.
function StarterPrompts({
  project,
  onPick,
}: {
  project: Project;
  onPick: (text: string) => void;
}) {
  const prompts: { label: string; text: string }[] = [
    {
      label: 'Review what’s here',
      text: `Take a look around ${project.path} and give me a quick tour: what files are here, how they’re organized, and what looks worth digging into.`,
    },
    {
      label: 'Summarize the data',
      text: `Read the data files in ${project.path} and write a short summary of what they contain — columns, sizes, any obvious patterns or anomalies.`,
    },
    {
      label: 'Build a report',
      text: `Help me build a report from the contents of ${project.path}. Start by asking what the report should cover.`,
    },
    {
      label: 'Investigate something',
      text: `I want to investigate something in ${project.path}. Ask me what I’m looking for, then dig in.`,
    },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
      {prompts.map((p) => (
        <button
          key={p.label}
          onClick={() => onPick(p.text)}
          className="px-2.5 py-1 rounded-full bg-card-strong border border-card hover:border-card-strong text-xs text-ink-muted hover:text-ink"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function EmptyWelcome({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-[760px] text-center">
        <HeroArt />
        <div className="mt-6 text-3xl font-semibold tracking-tight">
          Welcome to <span className="text-accent">overcli</span>
        </div>
        <div className="mt-3 text-sm text-ink-muted max-w-[520px] mx-auto">
          A native desktop home for the Claude, Codex, Gemini, and Ollama CLIs.
          Chat with any model, run background agents on isolated git worktrees,
          and coordinate work across multiple repos — no API keys, just the
          CLIs you already have signed in.
        </div>

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
          <FeatureCard
            accent="var(--c-backend-claude)"
            title="Projects"
            body="A project is a git repository on your machine. Chat with it, run tools, and keep one thread per task."
            icon={<ProjectGlyph />}
          />
          <FeatureCard
            accent="var(--c-backend-codex)"
            title="Agents"
            body="Build, review, or doc agents run in their own git worktrees so your main checkout stays clean."
            icon={<BranchGlyph />}
          />
          <FeatureCard
            accent="var(--c-backend-gemini)"
            title="Workspaces"
            body="Group several projects into one workspace and fire agents that span every repo at once."
            icon={<WorkspaceGlyph />}
          />
        </div>

        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            onClick={onPick}
            className="px-5 py-2.5 rounded-md bg-accent/30 text-accent hover:bg-accent/40 text-sm font-medium"
          >
            Add your first project
          </button>
          <div className="text-[11px] text-ink-faint">
            Pick a folder on disk. Git repos unlock agents; any folder works for chat.
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  accent,
  title,
  body,
  icon,
}: {
  accent: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-card bg-surface-elevated p-4 flex flex-col gap-2"
      style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
    >
      <div
        className="w-9 h-9 rounded-md flex items-center justify-center"
        style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
      >
        {icon}
      </div>
      <div className="text-sm font-medium text-ink">{title}</div>
      <div className="text-xs text-ink-muted leading-relaxed">{body}</div>
    </div>
  );
}

/// Decorative hero. Matches the app icon: a shell-prompt mark — a bar
/// above a right-pointing chevron — sized up and rendered in the
/// current-ink color so it inherits the light/dark theme.
function HeroArt() {
  return (
    <svg
      viewBox="0 0 120 120"
      className="mx-auto text-ink"
      width="120"
      height="120"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M28 34 H92" strokeWidth="12" />
        <path d="M36 58 L76 82 L36 106" strokeWidth="12" />
      </g>
    </svg>
  );
}

function ProjectGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="6" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 9c0-2 2-3 4-3h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function WorkspaceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5H5.7L6.7 3.6H12.5V5.5H3.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 5.5H4L5 6.5H14.5V13.3A1 1 0 0113.5 14.3H2.5A1 1 0 011.5 13.3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type BackendPrefs = {
  disabledBackends?: Partial<Record<Backend, boolean>>;
  preferredBackend?: Backend;
};

function isBackendEnabled(settings: BackendPrefs, backend: Backend): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

function enabledBackends(settings: BackendPrefs): Backend[] {
  const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  return all.filter((b) => isBackendEnabled(settings, b));
}

function firstEnabledBackend(settings: BackendPrefs): Backend {
  const preferred = settings.preferredBackend;
  if (preferred && isBackendEnabled(settings, preferred)) return preferred;
  return enabledBackends(settings)[0] ?? 'claude';
}

function ContextPill({
  label,
  projects,
  workspaces,
  onPickProject,
  onPickWorkspace,
  onAdd,
}: {
  label: string;
  projects: Project[];
  workspaces: Workspace[];
  onPickProject: (id: UUID) => void;
  onPickWorkspace: (id: UUID) => void;
  onAdd: () => void;
}) {
  const items: PillItem[] = [];
  if (workspaces.length > 0) {
    items.push({ value: '__h_workspaces__', label: 'Workspaces', kind: 'header' });
    for (const w of workspaces) {
      items.push({ value: `w:${w.id}`, label: w.name, note: `${w.projectIds.length} project${w.projectIds.length === 1 ? '' : 's'}` });
    }
  }
  if (projects.length > 0) {
    items.push({ value: '__h_projects__', label: 'Projects', kind: 'header' });
    for (const p of projects) {
      items.push({ value: `p:${p.id}`, label: p.name, note: shortPath(p.path) });
    }
  }
  items.push({ value: '__add__', label: '+ Add project…' });
  return (
    <Pill
      label={label}
      items={items}
      onPick={(v) => {
        if (v === '__add__') onAdd();
        else if (v.startsWith('w:')) onPickWorkspace(v.slice(2) as UUID);
        else if (v.startsWith('p:')) onPickProject(v.slice(2) as UUID);
      }}
    />
  );
}

function shortPath(p: string): string {
  // We don't have $HOME in the renderer (contextIsolation), so just
  // collapse any /Users/<anything>/ prefix to ~/ as a best-effort.
  return p.replace(/^\/Users\/[^/]+\//, '~/');
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
    codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
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
  kind?: 'header';
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
          {items.map((it) =>
            it.kind === 'header' ? (
              <div
                key={it.value}
                className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-ink-faint"
              >
                {it.label}
              </div>
            ) : (
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
            ),
          )}
        </div>
      )}
    </div>
  );
}
