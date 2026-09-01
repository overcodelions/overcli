import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  Backend,
  PermissionMode,
  EffortLevel,
  AppSettings,
  SidebarLayout,
  ThemePreference,
  BackendHealth,
} from '@shared/types';
import {
  PREMIUM_MODELS,
  friendlyModelLabel,
  latestAtTier,
  type ModelSpeed,
} from '@shared/modelCatalog';
import { EFFORT_BACKENDS } from '@shared/effort';
import type { UserProfile } from '@shared/flows/personalize';
import { Group, SheetActionButton } from './settingsChrome';
import { StoragePane } from './StoragePane';
import { ConversationsPane } from './ConversationsPane';

// Re-exported so the several sheets that already import it from here keep
// working now that the definition lives in ./settingsChrome.
export { SheetActionButton };

type Section =
  | 'general'
  | 'backends'
  | 'models'
  | 'local'
  | 'agents'
  | 'flows'
  | 'storage'
  | 'conversations'
  | 'advanced';

// Hoisted out of the panes so they aren't reallocated on every keystroke
// re-render (each render would otherwise create fresh arrays).
const ALL_BACKENDS_LIST: Backend[] = ['claude', 'codex', 'gemini', 'copilot', 'ollama'];
const CLI_BACKENDS: Exclude<Backend, 'ollama'>[] = ['claude', 'codex', 'gemini', 'copilot'];

// Tiers a flow actually spends, in the order the drafter reasons about them:
// the expensive end first, since that's the row a cost-conscious user comes
// here to change.
const FLOW_MODEL_TIERS: { tier: ModelSpeed; label: string; help: string }[] = [
  { tier: 'frontier', label: 'Frontier', help: 'The most capable, most expensive tier. Only used when a step explicitly asks for it.' },
  { tier: 'thinking', label: 'Thinking', help: 'Planning steps and the reviews that judge them.' },
  { tier: 'standard', label: 'Standard', help: 'Rebound critics and other mid-weight steps.' },
  { tier: 'fast', label: 'Fast', help: 'Implementers, test writers, extraction, formatting.' },
];

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
  // Only recompute when local edits or the saved settings actually change,
  // not on unrelated re-renders (e.g. backendHealth updates from a probe).
  const dirty = useMemo(
    () => JSON.stringify(local) !== JSON.stringify(settings),
    [local, settings],
  );

  return (
    <div className="flex flex-col w-full h-[min(780px,88vh)]">
      <div className="flex items-center px-5 pt-4 pb-3 border-b border-card">
        <div className="text-lg font-semibold">Settings</div>
      </div>
      <div className="flex flex-1 min-h-0">
        <nav className="w-[176px] flex-shrink-0 border-r border-card py-3 px-2 flex flex-col gap-0.5">
          <NavItem label="General" active={section === 'general'} onClick={() => setSection('general')} />
          <NavItem label="Backends" active={section === 'backends'} onClick={() => setSection('backends')} />
          <NavItem label="Models" active={section === 'models'} onClick={() => setSection('models')} />
          <NavItem label="Local models" active={section === 'local'} onClick={() => setSection('local')} />
          <NavItem label="Agents" active={section === 'agents'} onClick={() => setSection('agents')} />
          <NavItem label="Flows" active={section === 'flows'} onClick={() => setSection('flows')} />
          <NavItem label="Storage" active={section === 'storage'} onClick={() => setSection('storage')} />
          <NavItem label="Conversations" active={section === 'conversations'} onClick={() => setSection('conversations')} />
          <NavItem label="Advanced" active={section === 'advanced'} onClick={() => setSection('advanced')} />
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
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
          {section === 'flows' && <FlowsPane local={local} patch={patch} />}
          {section === 'storage' && <StoragePane />}
          {section === 'conversations' && <ConversationsPane />}
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

function Row({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return (
    // Help sits in its own grid row rather than inside the control column.
    // Inside it, the label could only ever be wrong: `items-center` centred it
    // against control-plus-help, so a long help line pushed it down, and
    // `items-start` left it a few pixels ABOVE the control — visibly so next
    // to a native select, which renders taller than a text input. As its own
    // row the label centres against the control alone, and the help still
    // lines up under the control, with no per-control padding to re-tune.
    <div className="grid grid-cols-[168px_1fr] items-center gap-x-4 gap-y-1">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="min-w-0">{children}</div>
      {help && (
        <>
          <div />
          <div className="text-[11px] text-ink-faint">{help}</div>
        </>
      )}
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
        {help && <span className="text-[11px] text-ink-faint">{help}</span>}
      </div>
    </label>
  );
}

/// What this install learned about the user from personalizing imported
/// workers. Read-only apart from forgetting: these are not settings anybody
/// sets, they are answers typed into an import form and kept so the next
/// import can pre-fill them (src/shared/flows/personalize.ts).
///
/// It is here because it is the only personal record the app keeps, and a
/// pile of facts about you that can only be edited by finding a JSON file in
/// userData is not a thing to ship. Nothing to configure means nothing to
/// save: it writes through immediately rather than joining the sheet's dirty
/// state.
function RememberedFacts() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    void window.overcli.invoke('workers:profile').then((res) => setProfile(res.profile));
  }, []);

  // An install that has never imported a shared worker has no such record,
  // and a permanently empty box is a promise that something should be there.
  if (!profile || profile.facts.length === 0) return null;

  const forget = (key?: string) =>
    void window.overcli.invoke('workers:forgetProfile', { key }).then((res) => setProfile(res.profile));

  return (
    <Group
      title="What overcli remembers about you"
      description="Answers you gave when personalizing a worker somebody shared with you. The next worker you import starts with these filled in."
    >
      {profile.facts.map((fact) => (
        <div key={fact.key} className="flex items-baseline gap-2 text-xs">
          <span className="text-ink-faint w-[140px] flex-shrink-0 truncate" title={fact.label}>
            {fact.label}
          </span>
          <span className="text-ink min-w-0 break-words">{fact.value}</span>
          <button
            onClick={() => forget(fact.key)}
            className="ml-auto text-[11px] text-ink-faint hover:text-rose-400 px-1.5 py-0.5 rounded hover:bg-white/5"
            title={`Forget ${fact.label}`}
          >
            Forget
          </button>
        </div>
      ))}
      <button
        onClick={() => forget()}
        className="self-start text-[11px] text-ink-faint hover:text-rose-400 mt-1"
      >
        Forget all of it
      </button>
    </Group>
  );
}

// ---------- Panes ----------

function GeneralPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group title="Appearance" description="Choose how overcli looks. System follows your OS setting.">
        <ThemePicker value={local.theme} onChange={(v) => patch({ theme: v })} />
      </Group>
      <RememberedFacts />
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
  const enabled = useMemo(
    () => ALL_BACKENDS_LIST.filter((b) => local.disabledBackends?.[b] !== true),
    [local.disabledBackends],
  );
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
        {ALL_BACKENDS_LIST.map((b) => (
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
        description="overcli auto-discovers CLIs in common install locations. Override here if yours is elsewhere."
      >
        {CLI_BACKENDS.map((b) => {
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

/// Sentinel for the per-backend effort select's "follow default" option.
/// Can't be '' — that's a real EffortLevel meaning Auto.
const FOLLOW_DEFAULT = '\u0000follow';

function ModelsPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group
        title="Default models"
        description="Used when a conversation doesn't have an explicit model override."
      >
        {CLI_BACKENDS.map((b) => (
          <Row key={b} label={b}>
            <select
              value={local.backendDefaultModels[b] ?? ''}
              onChange={(e) =>
                patch({
                  backendDefaultModels: { ...local.backendDefaultModels, [b]: e.target.value },
                })
              }
              className="field px-2 py-1 text-xs font-mono"
            >
              <option value="">{placeholderFor(b)}</option>
              {PREMIUM_MODELS[b].map((m) => (
                <option key={m} value={m}>
                  {friendlyModelLabel(b, m)}
                </option>
              ))}
            </select>
          </Row>
        ))}
      </Group>
      <Group
        title="Reasoning effort"
        description="Higher effort means deeper thinking, more output tokens, and slower turns — it is usually the largest single lever on latency. Auto is not a middle setting: it defers to each CLI's own default, and those differ by backend, so pin a backend below if you want to tune one without moving the other."
      >
        <Row label="Default">
          <select
            value={local.defaultEffort}
            onChange={(e) => patch({ defaultEffort: e.target.value as EffortLevel })}
            className="field px-2 py-1 text-xs"
          >
            <option value="">Auto (CLI/model default)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </Row>
        {EFFORT_BACKENDS.map((b) => (
          <Row key={b} label={b}>
            <select
              value={local.backendDefaultEfforts?.[b] ?? FOLLOW_DEFAULT}
              onChange={(e) => {
                const next = { ...(local.backendDefaultEfforts ?? {}) };
                // "Follow default" is a *missing* entry, not an entry
                // holding Auto — Auto is itself a real choice ('') that
                // must be able to override a non-Auto Default. Hence the
                // sentinel: the two cases can't share the empty string.
                if (e.target.value === FOLLOW_DEFAULT) delete next[b];
                else next[b] = e.target.value as EffortLevel;
                patch({ backendDefaultEfforts: next });
              }}
              className="field px-2 py-1 text-xs"
            >
              <option value={FOLLOW_DEFAULT}>Follow default</option>
              <option value="">Auto (CLI/model default)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="max">Max</option>
            </select>
          </Row>
        ))}
      </Group>
    </div>
  );
}

function placeholderFor(b: Backend): string {
  if (b === 'claude') return 'e.g. claude-opus-5';
  if (b === 'codex') return 'e.g. gpt-5.6-sol';
  if (b === 'ollama') return 'e.g. qwen2.5-coder:7b';
  if (b === 'copilot') return 'e.g. claude-haiku-4.5';
  return 'e.g. gemini-3.7-flash';
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
  const [ollamaPulledModels, setOllamaPulledModels] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.overcli.invoke('ollama:detect').then((det) => {
      if (cancelled) return;
      setOllamaPulledModels(det.models.map((m) => m.name));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <Group
        title="Default model"
        description="Used when a conversation picks Ollama without an explicit model override."
      >
        <select
          value={local.backendDefaultModels.ollama ?? ''}
          onChange={(e) =>
            patch({
              backendDefaultModels: { ...local.backendDefaultModels, ollama: e.target.value },
            })
          }
          className="field px-2 py-1 text-xs font-mono"
        >
          <option value="">{placeholderFor('ollama')}</option>
          {ollamaPulledModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
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

/// The outbound-webhook control. Its own component because the "Send test"
/// button needs local state for the result, and `AdvancedPane` is otherwise
/// a pure render of `local`.
///
/// The test posts the values currently TYPED, not the saved ones — testing a
/// value you have to Save first is a button that lies on its first use. That
/// applies doubly to the token, which the Save button never writes at all.
///
/// WHY THE TOKEN IS NOT PART OF `local`. Every other field here funnels into
/// `patch()`, which the sheet's Save button commits to `AppSettings` and hence
/// to `overcli.json` in the clear. A credential does not belong in that file,
/// so the token takes its own path: `notify:setWebhookToken` on blur, straight
/// into the keychain. The consequence is that it never comes BACK either — the
/// renderer is told only WHETHER one is configured, so the field shows a
/// placeholder and an explicit Clear button rather than a prefilled value.
function WebhookField({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const url = local.notificationWebhookUrl ?? '';
  const header = local.notificationWebhookAuthHeader ?? '';
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  /// What the user has typed this session. `''` means "typed nothing", which
  /// is NOT the same as "no token" — one may already be stored.
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{ configured: boolean; fromEnv: boolean } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    void window.overcli
      .invoke('notify:webhookTokenStatus')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const saveToken = (value: string | null) => {
    setTokenError(null);
    void window.overcli
      .invoke('notify:setWebhookToken', value)
      .then((res) => {
        if (!res.ok) {
          setTokenError(
            'Could not store the token — this host cannot persist secrets. Set $OVERCLI_NOTIFY_WEBHOOK_TOKEN instead.',
          );
          return;
        }
        setToken('');
        return window.overcli.invoke('notify:webhookTokenStatus').then(setStatus);
      })
      .catch((err: unknown) => setTokenError(String(err)));
  };

  const hasToken = token.trim() !== '' || status?.configured === true;

  return (
    <>
    <Row
      label="Webhook URL"
      help="Optional. overcli POSTs {text, title, body} as JSON here whenever it would otherwise only raise a desktop notification — scheduled-run failures, worker pauses waiting on your approval, watch hits. The text key alone renders in a Slack incoming webhook with no extra setup; title/body keep it usable for any generic receiver. Leave blank to turn it off."
    >
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="https://hooks.slack.com/services/..."
          value={url}
          onChange={(e) => {
            setResult(null);
            patch({ notificationWebhookUrl: e.target.value });
          }}
          className="field flex-1 px-2 py-1 text-xs font-mono"
        />
        <button
          disabled={testing || !url.trim()}
          onClick={() => {
            setTesting(true);
            setResult(null);
            void window.overcli
              .invoke('notify:testWebhook', {
                url,
                // A typed token wins; otherwise omit the key entirely so the
                // main process falls back to what is stored. `undefined` is
                // the "use what is saved" case — null would mean "no auth".
                token: token.trim() ? token.trim() : undefined,
                header: header.trim() ? header.trim() : undefined,
              })
              .then(setResult)
              .catch((err: unknown) => setResult({ ok: false, error: String(err) }))
              .finally(() => setTesting(false));
          }}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card flex-shrink-0 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {testing ? 'Sending…' : 'Send test'}
        </button>
      </div>
      {result && (
        <div className={'text-[10px] ' + (result.ok ? 'text-ink-muted' : 'text-red-300')}>
          {result.ok ? 'Sent — check the receiver.' : `Failed: ${result.error}`}
        </div>
      )}
    </Row>
    <Row
      label="Auth token"
      help="Optional. Sent verbatim as a request header, for receivers where the URL alone is not the credential — PagerDuty, an ntfy topic with access control, anything behind an API gateway. Stored in the OS keychain, never in overcli.json, and never shown back here. Type Bearer yourself if your receiver expects it: overcli sends exactly what you paste, because guessing breaks the receivers that want a raw token."
    >
      <div className="flex gap-2">
        <input
          type="password"
          placeholder={
            status?.fromEnv
              ? 'set by $OVERCLI_NOTIFY_WEBHOOK_TOKEN'
              : status?.configured
                ? 'configured — type to replace'
                : 'none'
          }
          value={token}
          disabled={status?.fromEnv === true}
          onChange={(e) => {
            setResult(null);
            setToken(e.target.value);
          }}
          onBlur={() => {
            if (token.trim()) saveToken(token.trim());
          }}
          className="field flex-1 px-2 py-1 text-xs font-mono disabled:opacity-40"
        />
        <button
          disabled={status?.fromEnv === true || (!status?.configured && !token.trim())}
          onClick={() => {
            setToken('');
            setResult(null);
            saveToken(null);
          }}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card flex-shrink-0 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Clear
        </button>
      </div>
      {status?.fromEnv && (
        <div className="text-[10px] text-ink-faint">
          The environment variable wins over anything stored here. Unset it to edit the token from
          Settings.
        </div>
      )}
      {tokenError && <div className="text-[10px] text-red-300">{tokenError}</div>}
    </Row>
    {hasToken && (
      <Row
        label="Auth header"
        help="Header name the token is sent under. Defaults to Authorization, which is what ntfy and PagerDuty want; use X-API-Key or a vendor-specific name if your receiver expects one."
      >
        <input
          type="text"
          placeholder="Authorization"
          value={header}
          onChange={(e) => {
            setResult(null);
            patch({ notificationWebhookAuthHeader: e.target.value });
          }}
          className="field w-full px-2 py-1 text-xs font-mono"
        />
      </Row>
    )}
    </>
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
        <Row
          label="Release idle sessions after"
          help="A conversation's CLI stays resident between turns — with every MCP server it started — so a stack of sessions you're no longer using can hold gigabytes. Once a session has been idle this long, overcli shuts it down; your next message respawns it and resumes the same thread. Raise it if you bounce between many conversations; Never keeps every session alive until quit."
        >
          <select
            value={String(local.idleSessionTimeoutMinutes ?? 30)}
            onChange={(e) => patch({ idleSessionTimeoutMinutes: Number(e.target.value) })}
            className="field px-2 py-1 text-xs"
          >
            <option value="10">10 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="180">3 hours</option>
            <option value="360">6 hours</option>
            <option value="0">Never</option>
          </select>
        </Row>
      </Group>
      <Group
        title="Notifications"
        description="Where overcli tells you a scheduled run failed or a worker is waiting on you."
      >
        <WebhookField local={local} patch={patch} />
      </Group>
      <Group title="Updates" description="Which build channel this app auto-updates from.">
        <Row label="Channel" help="Stable tracks tagged releases. Nightly tracks the rolling nightly prerelease — newer, less tested, and not notarized, so macOS Gatekeeper warns on a fresh nightly download. Switching takes effect immediately.">
          <select
            value={local.updateChannel ?? 'stable'}
            onChange={(e) => patch({ updateChannel: e.target.value as 'stable' | 'nightly' })}
            className="field px-2 py-1 text-xs"
          >
            <option value="stable">Stable</option>
            <option value="nightly">Nightly</option>
          </select>
        </Row>
      </Group>
      <Group title="Layout" description="Tuning reserved for when the defaults don't fit.">
        <Row
          label="Sidebar"
          help="Recent is one list of everything you've worked on, newest first, with the project printed once per run of rows. Places is your projects and workspaces as folders. The switch at the top of the sidebar sets the same thing."
        >
          <select
            value={local.sidebarLayout ?? 'stream'}
            onChange={(e) => patch({ sidebarLayout: e.target.value as SidebarLayout })}
            className="field px-2 py-1 text-xs"
          >
            <option value="stream">Recent</option>
            <option value="projects">Places</option>
          </select>
        </Row>
        <Toggle
          label="Show Working on section"
          help="Keeps a short list of what you're in the middle of at the top of the sidebar, ranked by how often you come back to it."
          value={local.showActiveSidebarSection ?? true}
          onChange={(v) => patch({ showActiveSidebarSection: v })}
        />
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
        <Toggle
          label="Use Claude Agent SDK (experimental)"
          help="Route Claude turns through @anthropic-ai/claude-agent-sdk in-process instead of spawning `claude -p`. Permission prompts route directly via canUseTool (no MCP broker round-trip). Survives future restrictions on `-p`."
          value={(local.claudeTransport ?? 'cli') === 'sdk'}
          onChange={(v) => patch({ claudeTransport: v ? 'sdk' : 'cli' })}
        />
        <Toggle
          label="Claude MCP debug logging"
          help="Launch the Claude CLI with `--debug mcp` so MCP server startup and registration diagnostics print to stderr. View them in the Debug sheet (enable “Show Debug button” above). Useful for diagnosing MCP issues like the permission broker failing to register in a crowded config. Noisy — leave off for normal use."
          value={local.claudeMcpDebug ?? false}
          onChange={(v) => patch({ claudeMcpDebug: v })}
        />
        <Toggle
          label="Claude artifacts and /design (experimental)"
          help="Sets CLAUDE_CODE_ARTIFACT on Claude launches, which unlocks the Artifact tool and the /design canvas skill — both are otherwise switched off in the headless sessions overcli drives, and /design just answers with its usage line. Needs a claude.ai login (not an API key); some accounts are gated regardless. The Artifact tool publishes to claude.ai, so leave permission prompts on for it."
          value={local.claudeArtifacts ?? false}
          onChange={(v) => patch({ claudeArtifacts: v })}
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

function FlowsPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Group title="Run behavior">
        <Toggle
          label="Run flows in a worktree by default"
          help="Starts the launcher's run-in toggle on “worktree”, so a flow forks a fresh worktree off the base branch instead of working in the project's main tree. You can still flip it per run."
          value={(local.defaultFlowRunIn ?? 'cwd') === 'worktree'}
          onChange={(v) => patch({ defaultFlowRunIn: v ? 'worktree' : 'cwd' })}
        />
      </Group>
      <FlowModelDefaultsPane local={local} patch={patch} />
      <FlowsRegistriesPane />
    </div>
  );
}

/// Which model each speed tier means when a flow is generated or started
/// from a template. A flow spends several models at once, so the useful
/// thing to pin isn't "the default model" (that's Settings → Models, for
/// conversations) but the tier mapping the drafter reasons in.
///
/// Auto reads the catalog, so a tier left alone keeps up with new models on
/// its own. Pinning is for disagreeing with the catalog — e.g. codex's only
/// standard-tier model is a generation behind, so a codex user may prefer
/// GPT-5.6 Luna there.
function FlowModelDefaultsPane({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const backends = CLI_BACKENDS.filter((b) => local.disabledBackends[b] !== true);
  const defaults = local.flowModelDefaults ?? {};

  function setTier(backend: Exclude<Backend, 'ollama'>, tier: ModelSpeed, model: string) {
    const forBackend = { ...(defaults[backend] ?? {}) };
    // An empty select value means auto — drop the key rather than storing a
    // blank, so `tierDefault` sees a genuinely unset tier.
    if (model) forBackend[tier] = model;
    else delete forBackend[tier];
    patch({ flowModelDefaults: { ...defaults, [backend]: forBackend } });
  }

  return (
    <Group
      title="Model defaults for flows"
      description="Which model each speed tier means when a flow is AI-generated or started from a template. Auto follows the catalog, so these keep up with new models on their own."
    >
      {backends.length === 0 && (
        <div className="text-xs text-ink-faint">Enable a CLI backend to set flow model defaults.</div>
      )}
      {backends.map((b) => (
        <div key={b} className="space-y-2">
          <div className="text-xs font-medium text-ink-muted">{b}</div>
          {FLOW_MODEL_TIERS.map(({ tier, label, help }) => {
            const auto = latestAtTier(b, tier);
            return (
              <Row key={tier} label={label} help={help}>
                <select
                  value={defaults[b]?.[tier] ?? ''}
                  onChange={(e) => setTier(b, tier, e.target.value)}
                  className="field px-2 py-1 text-xs font-mono"
                >
                  <option value="">
                    {auto ? `Auto — ${friendlyModelLabel(b, auto)}` : 'Auto — none at this tier'}
                  </option>
                  {PREMIUM_MODELS[b].map((m) => (
                    <option key={m} value={m}>
                      {friendlyModelLabel(b, m)}
                    </option>
                  ))}
                </select>
              </Row>
            );
          })}
        </div>
      ))}
    </Group>
  );
}

function FlowsRegistriesPane() {
  const [registries, setRegistries] = useState<import('@shared/types').FlowRegistry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingAuth, setEditingAuth] = useState('');
  const [formKind, setFormKind] = useState<'remote' | 'local'>('remote');
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formDir, setFormDir] = useState('');
  const [formAuth, setFormAuth] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const formLocator = formKind === 'local' ? formDir : formUrl;

  useEffect(() => {
    void window.overcli.invoke('flows:listRegistries').then(setRegistries);
  }, []);

  async function handlePickDir() {
    const picked = await window.overcli.invoke('fs:pickDirectory');
    if (picked && picked.length > 0) setFormDir(picked[0]);
  }

  async function handleAddRegistry() {
    if (!formId || !formName || !formLocator) return;
    const result = await window.overcli.invoke('flows:upsertRegistry', {
      registry:
        formKind === 'local'
          ? { id: formId, name: formName, dir: formDir }
          : { id: formId, name: formName, indexUrl: formUrl },
      authHeader: formKind === 'local' ? undefined : formAuth || undefined,
    });
    if (result.ok) {
      setFormId('');
      setFormName('');
      setFormUrl('');
      setFormDir('');
      setFormAuth('');
      setFormError(null);
      const updated = await window.overcli.invoke('flows:listRegistries');
      setRegistries(updated);
    } else {
      setFormError(result.error);
    }
  }

  async function handleRemoveRegistry(id: string) {
    const result = await window.overcli.invoke('flows:removeRegistry', { registryId: id });
    if (result.ok) {
      const updated = await window.overcli.invoke('flows:listRegistries');
      setRegistries(updated);
    }
  }

  async function handleSaveAuth(id: string) {
    const reg = registries.find((r) => r.id === id);
    if (!reg) return;
    const result = await window.overcli.invoke('flows:upsertRegistry', {
      registry: reg,
      authHeader: editingAuth || null,
    });
    if (result.ok) {
      setEditingId(null);
      setEditingAuth('');
    }
  }

  return (
    <div className="space-y-5">
      <Group title="Registries" description="Manage flow registries">
        {registries.map((reg) => (
          <div key={reg.id} className="flex items-center justify-between gap-4 p-2 rounded border border-card">
            <div className="flex-1">
              <div className="font-semibold text-sm flex items-center gap-2">
                {reg.name}
                {reg.dir && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-card text-ink-faint font-normal"
                    title="Read straight from this folder. overcli never runs git — pull it yourself."
                  >
                    local folder
                  </span>
                )}
              </div>
              <div className="text-xs text-ink-faint mt-1 break-all">{reg.dir ?? reg.indexUrl}</div>
            </div>
            {reg.dir ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleRemoveRegistry(reg.id)}
                  className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong"
                >
                  Remove
                </button>
              </div>
            ) : editingId === reg.id ? (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  placeholder="Auth header (optional)"
                  value={editingAuth}
                  onChange={(e) => setEditingAuth(e.target.value)}
                  className="text-xs px-2 py-1 rounded border border-card bg-card"
                />
                <button
                  onClick={() => handleSaveAuth(reg.id)}
                  className="text-xs px-2 py-1 rounded bg-accent/30 text-accent hover:bg-accent/40"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingId(null);
                    setEditingAuth('');
                  }}
                  className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => {
                    setEditingId(reg.id);
                    setEditingAuth('');
                  }}
                  className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong"
                >
                  Edit auth
                </button>
                <button
                  onClick={() => handleRemoveRegistry(reg.id)}
                  disabled={reg.id === 'official'}
                  className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
      </Group>

      <Group title="Add registry">
        <div className="flex gap-1 p-0.5 rounded bg-card w-fit">
          {(['remote', 'local'] as const).map((kind) => (
            <button
              key={kind}
              onClick={() => {
                setFormKind(kind);
                setFormError(null);
              }}
              className={
                'text-xs px-2.5 py-1 rounded ' +
                (formKind === kind ? 'bg-accent/30 text-accent' : 'text-ink-muted hover:text-ink')
              }
            >
              {kind === 'remote' ? 'Remote URL' : 'Local folder'}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Registry ID (slug)"
          value={formId}
          onChange={(e) => setFormId(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-card bg-card"
        />
        <input
          type="text"
          placeholder="Name"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-card bg-card"
        />
        {formKind === 'local' ? (
          <>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="/path/to/my-flows"
                value={formDir}
                onChange={(e) => setFormDir(e.target.value)}
                className="flex-1 text-xs px-2 py-1 rounded border border-card bg-card"
              />
              <button
                onClick={handlePickDir}
                className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card flex-shrink-0"
              >
                Choose…
              </button>
            </div>
            <div className="text-[11px] text-ink-faint -mt-1">
              Every <code>*.yaml</code> file in the folder is offered as a flow — no index file to
              maintain. Point it at a git repo you already have and keep it current the usual way;
              overcli only reads the folder, it never pulls.
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              placeholder="Index URL (https://...)"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-card bg-card"
            />
            <input
              type="password"
              placeholder="Auth header (optional)"
              value={formAuth}
              onChange={(e) => setFormAuth(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-card bg-card"
            />
            <div className="text-[11px] text-ink-faint -mt-1">
              Sent verbatim as the <code>Authorization</code> header. Use <code>Bearer &lt;token&gt;</code> for GitHub/GitLab/Bitbucket Cloud OAuth, or <code>Basic &lt;base64&gt;</code> for Bitbucket Cloud app passwords.
            </div>
          </>
        )}
        {formError && (
          <div className="text-[11px] text-red-600 bg-red-500/10 rounded px-2 py-1">{formError}</div>
        )}
        <button
          onClick={handleAddRegistry}
          disabled={!formId || !formName || !formLocator}
          className="text-xs px-3 py-1 rounded bg-accent/30 text-accent hover:bg-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add registry
        </button>
      </Group>
    </div>
  );
}
