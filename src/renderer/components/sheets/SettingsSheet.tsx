import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import {
  Backend,
  PermissionMode,
  EffortLevel,
  AppSettings,
  ThemePreference,
  BackendHealth,
} from '@shared/types';

type Section = 'general' | 'backends' | 'models' | 'local' | 'agents' | 'advanced';

/// Redesigned to match the Mac app's sectioned layout — a narrow nav rail
/// on the left, a scrollable content pane on the right, and a single
/// bottom bar that commits everything. Matches macOS System Settings
/// in feel so it reads as a familiar shape rather than an ad-hoc form.
export function SettingsSheet() {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const refreshHealth = useStore((s) => s.refreshBackendHealth);
  const backendHealth = useStore((s) => s.backendHealth);
  const [local, setLocal] = useState<AppSettings>(settings);
  const [section, setSection] = useState<Section>('general');
  useEffect(() => setLocal(settings), [settings]);

  const patch = (delta: Partial<AppSettings>) => setLocal((p) => ({ ...p, ...delta }));
  const dirty = JSON.stringify(local) !== JSON.stringify(settings);

  return (
    <div className="flex flex-col w-full h-[min(640px,80vh)]">
      <div className="flex items-center px-5 pt-4 pb-3 border-b border-card">
        <div className="text-lg font-semibold">Settings</div>
      </div>
      <div className="flex flex-1 min-h-0">
        <nav className="w-[160px] flex-shrink-0 border-r border-card py-3 px-2 flex flex-col gap-0.5">
          <NavItem label="General" active={section === 'general'} onClick={() => setSection('general')} />
          <NavItem label="Backends" active={section === 'backends'} onClick={() => setSection('backends')} />
          <NavItem label="Models" active={section === 'models'} onClick={() => setSection('models')} />
          <NavItem label="Local models" active={section === 'local'} onClick={() => setSection('local')} />
          <NavItem label="Agents" active={section === 'agents'} onClick={() => setSection('agents')} />
          <NavItem label="Advanced" active={section === 'advanced'} onClick={() => setSection('advanced')} />
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto p-5">
          {section === 'general' && <GeneralPane local={local} patch={patch} />}
          {section === 'backends' && (
            <BackendsPane
              local={local}
              patch={patch}
              health={backendHealth}
              refresh={() => void refreshHealth()}
            />
          )}
          {section === 'models' && <ModelsPane local={local} patch={patch} />}
          {section === 'local' && <OllamaPane local={local} patch={patch} />}
          {section === 'agents' && <AgentsPane local={local} patch={patch} />}
          {section === 'advanced' && <AdvancedPane local={local} patch={patch} />}
        </div>
      </div>
      <div className="px-5 py-3 border-t border-card flex items-center justify-between">
        <div className="text-[11px] text-ink-faint">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </div>
        <div className="flex gap-2">
          <SheetActionButton
            label="Close"
            onClick={() => useStore.getState().openSheet(null)}
          />
          <SheetActionButton
            label="Save"
            primary
            disabled={!dirty}
            onClick={() => {
              void save(local);
              useStore.getState().openSheet(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- Nav / chrome ----------

function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'text-left text-xs px-2.5 py-1.5 rounded ' +
        (active
          ? 'bg-white/10 text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
    >
      {label}
    </button>
  );
}

function Group({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">{title}</div>
      {description && <div className="text-xs text-ink-faint mb-2">{description}</div>}
      <div className="flex flex-col gap-2 rounded-lg bg-card border border-card p-3">
        {children}
      </div>
    </section>
  );
}

function Row({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="flex flex-col gap-1">
        {children}
        {help && <div className="text-[10px] text-ink-faint">{help}</div>}
      </div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
  help,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        'flex items-start gap-3 select-none group ' +
        (disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer')
      }
    >
      <div
        onClick={() => {
          if (disabled) return;
          onChange(!value);
        }}
        className={
          'mt-0.5 w-7 h-4 rounded-full flex-shrink-0 relative transition-colors border ' +
          (value
            ? 'bg-accent border-accent'
            : 'bg-card-strong border-card-strong group-hover:bg-card')
        }
      >
        <div
          className={
            'absolute top-px w-3 h-3 rounded-full transition-all shadow ' +
            (value ? 'left-[13px] bg-white' : 'left-px bg-ink-muted')
          }
        />
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-ink">{label}</span>
        {help && <span className="text-[10px] text-ink-faint">{help}</span>}
      </div>
    </label>
  );
}

// ---------- Panes ----------

function GeneralPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group title="Appearance" description="Choose how OverCLI looks. System follows your OS setting.">
        <ThemePicker value={local.theme} onChange={(v) => patch({ theme: v })} />
      </Group>
      <Group title="Chat display">
        <Toggle
          label="Show cost per turn"
          help="Display the USD cost in the footer of each completed turn."
          value={local.showCost}
          onChange={(v) => patch({ showCost: v })}
        />
        <Toggle
          label="Show tool activity by default"
          help="Initial value for the eye toggle in the conversation header. Off keeps the chat focused on the assistant's prose; you can still flip it per session."
          value={local.defaultShowToolActivity}
          onChange={(v) => patch({ defaultShowToolActivity: v })}
        />
      </Group>
    </div>
  );
}

function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (v: ThemePreference) => void }) {
  const options: { value: ThemePreference; label: string; swatch: React.ReactNode }[] = [
    { value: 'light', label: 'Light', swatch: <ThemeSwatch bg="#f6f6f8" fg="#17171c" accent="#5d72ff" /> },
    { value: 'dark', label: 'Dark', swatch: <ThemeSwatch bg="#1c1c21" fg="#e8e8ee" accent="#7c8bff" /> },
    { value: 'system', label: 'System', swatch: <ThemeSwatch split /> },
  ];
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            'flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ' +
            (value === o.value
              ? 'border-accent bg-accent/10'
              : 'border-card-strong hover:bg-card-strong')
          }
        >
          {o.swatch}
          <span className="text-[11px] text-ink-muted">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function ThemeSwatch({
  bg,
  fg,
  accent,
  split,
}: {
  bg?: string;
  fg?: string;
  accent?: string;
  split?: boolean;
}) {
  if (split) {
    return (
      <div className="w-14 h-10 rounded-md overflow-hidden border border-card-strong relative">
        <div className="absolute inset-0 flex">
          <div className="flex-1 bg-[#f6f6f8]">
            <div className="absolute top-1 left-1 w-3 h-[3px] rounded" style={{ background: '#5d72ff' }} />
            <div className="absolute top-3 left-1 w-5 h-[2px] rounded bg-[#17171c]/60" />
          </div>
          <div className="flex-1 bg-[#1c1c21]">
            <div className="absolute top-1 right-1 w-3 h-[3px] rounded" style={{ background: '#7c8bff' }} />
            <div className="absolute top-3 right-1 w-5 h-[2px] rounded bg-[#e8e8ee]/60" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="w-14 h-10 rounded-md overflow-hidden border border-card-strong relative"
      style={{ background: bg }}
    >
      <div className="absolute top-1 left-1 w-3 h-[3px] rounded" style={{ background: accent }} />
      <div className="absolute top-3 left-1 w-5 h-[2px] rounded" style={{ background: fg, opacity: 0.6 }} />
      <div className="absolute top-5 left-1 w-7 h-[2px] rounded" style={{ background: fg, opacity: 0.4 }} />
      <div className="absolute top-7 left-1 w-4 h-[2px] rounded" style={{ background: fg, opacity: 0.4 }} />
    </div>
  );
}

function BackendsPane({
  local,
  patch,
  health,
  refresh,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  health: Record<string, BackendHealth>;
  refresh: () => void;
}) {
  const backends: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  const enabled = backends.filter((b) => local.disabledBackends?.[b] !== true);
  const enabledCount = enabled.length;
  const preferredValue =
    local.preferredBackend && enabled.includes(local.preferredBackend)
      ? local.preferredBackend
      : '';
  return (
    <div>
      <Group
        title="Enabled backends"
        description="Disabled backends are hidden from pickers and won't be used as defaults."
      >
        {backends.map((b) => (
          <Toggle
            key={b}
            label={b}
            value={local.disabledBackends?.[b] !== true}
            disabled={enabledCount <= 1 && local.disabledBackends?.[b] !== true}
            onChange={(v) =>
              patch({
                disabledBackends: {
                  ...(local.disabledBackends ?? {}),
                  [b]: !v,
                },
              })
            }
          />
        ))}
      </Group>
      <Group
        title="Default backend"
        description="Picked when creating a new conversation or agent. Auto uses the first enabled backend."
      >
        <Row label="Preferred">
          <select
            value={preferredValue}
            onChange={(e) =>
              patch({
                preferredBackend: e.target.value ? (e.target.value as Backend) : undefined,
              })
            }
            className="field px-2 py-1 text-xs"
          >
            <option value="">Auto (first enabled)</option>
            {enabled.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group
        title="CLI paths"
        description="OverCLI auto-discovers CLIs in common install locations. Override here if yours is elsewhere."
      >
        {(['claude', 'codex', 'gemini'] as Backend[]).map((b) => {
          const h = health[b];
          return (
            <div key={b} className="grid grid-cols-[80px_1fr_auto] items-center gap-2">
              <div className="text-xs text-ink-muted">{b}</div>
              <input
                placeholder="(auto-discovered)"
                value={local.backendPaths[b] ?? ''}
                onChange={(e) =>
                  patch({ backendPaths: { ...local.backendPaths, [b]: e.target.value } })
                }
                className="field px-2 py-1 text-xs font-mono"
              />
              <HealthBadge kind={h?.kind ?? 'unknown'} message={h?.message} />
            </div>
          );
        })}
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={refresh}
            className="text-[10px] text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-card-strong"
          >
            ↻ Re-check health
          </button>
        </div>
      </Group>
    </div>
  );
}

function ModelsPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const backends: Backend[] = ['claude', 'codex', 'gemini'];
  return (
    <div>
      <Group
        title="Default models"
        description="Used when a conversation doesn't have an explicit model override."
      >
        {backends.map((b) => (
          <Row key={b} label={b}>
            <input
              placeholder={placeholderFor(b)}
              value={local.backendDefaultModels[b] ?? ''}
              onChange={(e) =>
                patch({
                  backendDefaultModels: { ...local.backendDefaultModels, [b]: e.target.value },
                })
              }
              className="field px-2 py-1 text-xs font-mono"
            />
          </Row>
        ))}
      </Group>
      <Group title="Reasoning effort" description="Only applies to Claude. Higher effort = deeper thinking, more tokens.">
        <Row label="Default">
          <select
            value={local.defaultEffort}
            onChange={(e) => patch({ defaultEffort: e.target.value as EffortLevel })}
            className="field px-2 py-1 text-xs"
          >
            <option value="">Let Claude decide</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </Row>
      </Group>
    </div>
  );
}

function placeholderFor(b: Backend): string {
  if (b === 'claude') return 'e.g. claude-opus-4-7';
  if (b === 'codex') return 'e.g. gpt-5.4';
  if (b === 'ollama') return 'e.g. qwen2.5-coder:7b';
  return 'e.g. gemini-2.5-pro';
}

// ---------- Local models (Ollama) ----------
// Full dashboard lives in the "Local" tab. This pane just exposes the
// default-model override, which is config-shaped and belongs with the
// other backend defaults.

function OllamaPane({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  return (
    <div>
      <Group
        title="Default model"
        description="Used when a conversation picks Ollama without an explicit model override."
      >
        <input
          placeholder={placeholderFor('ollama')}
          value={local.backendDefaultModels.ollama ?? ''}
          onChange={(e) =>
            patch({
              backendDefaultModels: { ...local.backendDefaultModels, ollama: e.target.value },
            })
          }
          className="field px-2 py-1 text-xs font-mono"
        />
      </Group>
      <div className="text-xs text-ink-faint">
        Manage the Ollama server, pull models, and monitor logs from the{' '}
        <button
          onClick={() => {
            useStore.getState().setDetailMode('local');
            useStore.getState().openSheet(null);
          }}
          className="underline hover:text-ink"
        >
          Local tab
        </button>
        .
      </div>
    </div>
  );
}

function AgentsPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group
        title="Branch prefix"
        description="Every agent worktree lives on a new branch named <prefix><agent-name>."
      >
        <input
          value={local.agentBranchPrefix}
          onChange={(e) => patch({ agentBranchPrefix: e.target.value })}
          className="field px-2 py-1 text-xs font-mono"
        />
      </Group>
      <Group title="Permissions" description="Starting permission mode for brand-new conversations.">
        <Row label="Default mode">
          <select
            value={local.defaultPermissionMode}
            onChange={(e) => patch({ defaultPermissionMode: e.target.value as PermissionMode })}
            className="field px-2 py-1 text-xs"
          >
            <option value="default">Default</option>
            <option value="plan">Plan (read-only until told)</option>
            <option value="acceptEdits">Accept edits</option>
            <option value="bypassPermissions">Bypass (dangerous)</option>
          </select>
        </Row>
      </Group>
    </div>
  );
}

function AdvancedPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group title="Resilience">
        <Toggle
          label="Auto-downgrade on capacity errors"
          help="If the active CLI hits a rate limit or capacity error, respawn on a lower-tier model automatically and retry the turn."
          value={local.autoDowngrade}
          onChange={(v) => patch({ autoDowngrade: v })}
        />
      </Group>
      <Group title="Layout" description="Tuning reserved for when the defaults don't fit.">
        <Row label="Sidebar width" help="Drag the sidebar edge to resize; double-click to reset.">
          <div className="text-[11px] text-ink-faint">{local.sidebarWidth}px</div>
        </Row>
        <Row label="Editor pane" help="Drag the editor pane edge to resize; double-click to reset.">
          <div className="text-[11px] text-ink-faint">{local.editorPaneWidth}px</div>
        </Row>
      </Group>
      <Group title="Developer">
        <Toggle
          label="Show Debug button in sidebar"
          help="Adds a Debug entry to the sidebar footer that opens the diagnostics sheet."
          value={local.showDebug ?? false}
          onChange={(v) => patch({ showDebug: v })}
        />
      </Group>
    </div>
  );
}

function HealthBadge({ kind, message }: { kind: string; message?: string }) {
  const colors: Record<string, string> = {
    ready: 'bg-green-500/20 text-green-300',
    unauthenticated: 'bg-amber-500/20 text-amber-300',
    missing: 'bg-red-500/20 text-red-300',
    unknown: 'bg-white/10 text-ink-faint',
    error: 'bg-red-500/20 text-red-300',
  };
  return (
    <span
      className={'text-[10px] px-2 py-0.5 rounded ' + (colors[kind] ?? colors.unknown)}
      title={message}
    >
      {kind}
    </span>
  );
}

export function SheetActionButton({
  label,
  onClick,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'px-3 py-1 rounded text-xs border disabled:opacity-40 disabled:cursor-not-allowed ' +
        (primary
          ? 'bg-accent/30 border-accent/60 text-accent hover:bg-accent/40'
          : 'border-transparent text-ink-muted hover:text-ink hover:bg-card-strong hover:border-card')
      }
    >
      {label}
    </button>
  );
}
