import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  Backend,
  PermissionMode,
  EffortLevel,
  AppSettings,
  ThemePreference,
  BackendHealth,
  SlackStatus,
  IPCInvokeMap,
} from '@shared/types';
import {
  PREMIUM_MODELS,
  friendlyModelLabel,
  latestAtTier,
  type ModelSpeed,
} from '@shared/modelCatalog';
import { EFFORT_BACKENDS } from '@shared/effort';
import type { UserProfile } from '@shared/flows/personalize';
import { Group, Row, SheetActionButton } from './settingsChrome';
import { LABS, labOn, type LabKey } from '@shared/labs';
import { UI_SCALE_STEPS } from '@shared/uiScale';
import { defaultTranscriptLevel, TRANSCRIPT_LEVELS, type TranscriptLevel } from '@shared/transcriptLevel';
import { ConversationsPane } from './ConversationsPane';
import { AutoTidyPane } from './AutoTidyPane';
import { OrgSetupGuide } from './OrgSetupGuide';

// Re-exported so the several sheets that already import it from here keep
// working now that the definition lives in ./settingsChrome.
export { SheetActionButton };

const SECTIONS = [
  'general', 'backends', 'models', 'local', 'agents', 'flows',
  'services', 'conversations', 'autoTidy', 'org', 'labs', 'advanced',
] as const;
type Section = (typeof SECTIONS)[number];

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
export function SettingsSheet({ initialSection }: { initialSection?: string } = {}) {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const refreshHealth = useStore((s) => s.refreshBackendHealth);
  const backendHealth = useStore((s) => s.backendHealth);
  const [local, setLocal] = useState<AppSettings>(settings);
  const [section, setSection] = useState<Section>(
    SECTIONS.includes(initialSection as Section) ? (initialSection as Section) : 'general',
  );
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
          <NavItem label="Services" active={section === 'services'} onClick={() => setSection('services')} />
          <NavItem label="Conversations" active={section === 'conversations'} onClick={() => setSection('conversations')} />
          <NavItem label="Auto-tidy" active={section === 'autoTidy'} onClick={() => setSection('autoTidy')} />
          <NavItem label="Your org" active={section === 'org'} onClick={() => setSection('org')} />
          <NavItem label="Labs" active={section === 'labs'} onClick={() => setSection('labs')} />
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
          {section === 'services' && <ServicesSettingsPane local={local} patch={patch} />}
          {section === 'conversations' && <ConversationsPane />}
          {section === 'autoTidy' && <AutoTidyPane />}
          {section === 'org' && (local.orgAlpha ? <OrgPane local={local} patch={patch} /> : <OrgIntro patch={patch} />)}
          {section === 'labs' && <LabsPane local={local} patch={patch} />}
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
        <Row
          label="Interface size"
          help="Scales all text and controls. ⌘/Ctrl + and − change it from anywhere."
        >
          <UiScalePicker value={local.uiScale} onChange={(v) => patch({ uiScale: v })} />
        </Row>
      </Group>
      <RememberedFacts />
      <Group title="Chat display">
        <Toggle
          label="Show cost per turn"
          help="Display the USD cost in the footer of each completed turn."
          value={local.showCost}
          onChange={(v) => patch({ showCost: v })}
        />
        <Row
          label="Conversation detail"
          help={`${TRANSCRIPT_LEVELS.find((l) => l.value === defaultTranscriptLevel(local))?.help ?? ''} Each conversation can pick its own from the eye in its header.`}
        >
          <select
            value={defaultTranscriptLevel(local)}
            onChange={(e) => patch({ defaultTranscriptLevel: e.target.value as TranscriptLevel })}
            className="field px-2 py-1 text-xs"
          >
            {TRANSCRIPT_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
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

/// A value between steps (hand-edited, say) highlights nothing rather than
/// pretending to be the nearest step.
function UiScalePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-0.5 p-0.5 rounded-md border border-card-strong w-fit">
      {UI_SCALE_STEPS.map((step) => (
        <button
          key={step}
          onClick={() => onChange(step)}
          className={
            'text-[11px] px-2.5 py-1 rounded transition-colors ' +
            (Math.abs(value - step) < 1e-6
              ? 'bg-accent/10 text-accent'
              : 'text-ink-muted hover:text-ink hover:bg-card-strong')
          }
        >
          {Math.round(step * 100)}%
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
          {/* A badge says a CLI is missing or signed out; it does not say
              what to run about it. The setup guide does, and this is the
              screen someone is already on when they find out. */}
          <button
            onClick={() => useStore.getState().openSheet({ type: 'setup' })}
            className="text-[10px] text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-card-strong"
          >
            Install or sign in…
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
  if (b === 'claude') return 'e.g. claude-opus-5-5';
  if (b === 'codex') return 'e.g. gpt-6.1-sol';
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
  const tabOn = labOn(local.labs, 'localModels');
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
      {!tabOn && (
        <LabOffNotice
          text="The Local models tab is switched off in Labs. These settings still apply to any chat that uses Ollama."
          action="Show the tab"
          onTurnOn={() => patch({ labs: allLabs(local.labs, { localModels: true }) })}
        />
      )}
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
            <option value="auto">Auto (Claude; other CLIs start in Default)</option>
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

/// Coarse relative time for the delivery line. Coarse on purpose: the
/// question it answers is "is this working", not "exactly when".
function describeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
/// The Slack bridge. Tokens save on blur through their own channel, like the
/// webhook token — they are credentials and never enter `AppSettings`. The
/// on/off switch is an ordinary setting and applies on Save.
function SlackField({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [typed, setTyped] = useState<{ bot: string; app: string }>({ bot: '', app: '' });
  const [errors, setErrors] = useState<{ bot?: string; app?: string }>({});
  const [check, setCheck] = useState<{ ok: boolean; team?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.overcli.invoke('slack:status').then(setStatus).catch(() => setStatus(null));
    return window.overcli.onMainEvent((event) => {
      if (event.type === 'slackStatus') setStatus(event.status);
    });
  }, []);

  const saveToken = (kind: 'bot' | 'app', value: string | null) => {
    setErrors((e) => ({ ...e, [kind]: undefined }));
    setCheck(null);
    void window.overcli.invoke('slack:setToken', { kind, token: value }).then((res) => {
      if (!res.ok) {
        setErrors((e) => ({ ...e, [kind]: res.error ?? 'Could not store the token.' }));
        return;
      }
      setTyped((t) => ({ ...t, [kind]: '' }));
      return window.overcli.invoke('slack:status').then(setStatus);
    });
  };

  const tokenRow = (kind: 'bot' | 'app') => {
    const configured = kind === 'bot' ? status?.botConfigured : status?.appConfigured;
    const fromEnv = kind === 'bot' ? status?.botFromEnv : status?.appFromEnv;
    const env = kind === 'bot' ? 'OVERCLI_SLACK_BOT_TOKEN' : 'OVERCLI_SLACK_APP_TOKEN';
    return (
      <Row
        label={kind === 'bot' ? 'Bot token' : 'App-level token'}
        help={
          kind === 'bot'
            ? 'xoxb-… from OAuth & Permissions. Create the app from src/main/slack/slack-app-manifest.yml so it has every scope and event it needs. Stored in the OS keychain.'
            : 'xapp-… from Basic Information → App-Level Tokens, with connections:write. The manifest already turns on Socket Mode, Interactivity and the bot events.'
        }
      >
        <div className="flex gap-2">
          <input
            type="password"
            placeholder={fromEnv ? `set by $${env}` : configured ? 'configured — type to replace' : 'none'}
            value={typed[kind]}
            disabled={fromEnv === true}
            onChange={(e) => setTyped((t) => ({ ...t, [kind]: e.target.value }))}
            onBlur={() => {
              if (typed[kind].trim()) saveToken(kind, typed[kind].trim());
            }}
            className="field flex-1 px-2 py-1 text-xs font-mono disabled:opacity-40"
          />
          <button
            disabled={fromEnv === true || (!configured && !typed[kind].trim())}
            onClick={() => saveToken(kind, null)}
            className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card flex-shrink-0 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Clear
          </button>
        </div>
        {errors[kind] && <div className="text-[10px] text-red-300">{errors[kind]}</div>}
      </Row>
    );
  };

  const saved = status?.enabled === true;
  return (
    <>
      <Toggle
        label="Send questions and approvals to managers in Slack"
        value={!!local.slackEnabled}
        onChange={(v) => patch({ slackEnabled: v })}
        help="Only for workers with a manager whose Slack member ID is set (in the worker's settings, or on a worker it reports to). Run one overcli per Slack app — a second one on the same tokens would take replies meant for this one."
      />
      {tokenRow('bot')}
      {tokenRow('app')}
      <Row
        label="Your Slack member ID"
        help="DM the bot, or @mention it, to ask this laptop's workers for something from anywhere. Only you: requests from anyone else are turned down. In Slack: your profile → ⋯ → Copy member ID."
      >
        <input
          type="text"
          placeholder="U012AB3CD"
          value={local.slackOwnerId ?? ''}
          onChange={(e) => patch({ slackOwnerId: e.target.value.trim() || undefined })}
          className="field w-40 px-2 py-1 text-xs font-mono"
        />
        {local.slackOwnerId && !/^[UW][A-Z0-9]{6,}$/.test(local.slackOwnerId) && (
          <div className="text-[10px] text-red-300">That doesn't look like a member ID. It starts with U and looks like U012AB3CD.</div>
        )}
      </Row>
      <Row label="Connection">
        <div className="flex items-center gap-2">
          <span className={'text-xs ' + (status?.connected ? 'text-emerald-300' : 'text-ink-muted')}>
            {status?.connected
              ? `Connected to ${status.team ?? 'Slack'}${status.openThreads ? ` · ${status.openThreads} waiting on a manager` : ''}`
              : saved
                ? 'Not connected'
                : 'Off'}
          </span>
          <button
            disabled={busy || !status?.botConfigured}
            onClick={() => {
              setBusy(true);
              setCheck(null);
              void window.overcli
                .invoke(saved ? 'slack:reconnect' : 'slack:test')
                .then((res) => setCheck(res as { ok: boolean; team?: string; error?: string }))
                .finally(() => setBusy(false));
            }}
            className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {saved ? 'Reconnect' : 'Test bot token'}
          </button>
        </div>
        {status?.error && !status.connected && <div className="text-[10px] text-red-300">{status.error}</div>}
        {check && (
          <div className={'text-[10px] ' + (check.ok ? 'text-ink-muted' : 'text-red-300')}>
            {check.ok ? (check.team ? `Bot token works for ${check.team}.` : 'Reconnected.') : check.error}
          </div>
        )}
      </Row>
    </>
  );
}

/// Your org's overcli server. Signing in pairs this app with it: an invite
/// link signs in at once; a server address opens the org's page in the
/// browser to confirm a code. Either way the token goes to the keychain and
/// nobody copies it. Pasting a token stays, folded away, for scripts.
function OrgServerField({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [address, setAddress] = useState(local.orgServerUrl ?? '');
  const [status, setStatus] = useState<ReturnType<IPCInvokeMap['org:status']> | null>(null);
  const [pairing, setPairing] = useState<{ userCode: string; verifyUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const refresh = () => {
    void window.overcli.invoke('org:status').then(setStatus);
  };
  useEffect(() => {
    refresh();
    return window.overcli.onMainEvent((event) => {
      if (event.type !== 'orgSignIn') return;
      setPairing(null);
      setBusy(false);
      if (event.outcome === 'signedIn') refresh();
      else
        setError(
          event.outcome === 'denied'
            ? 'The sign-in was refused in the browser.'
            : event.outcome === 'expired'
              ? 'The code expired before it was confirmed. Try again.'
              : event.error ?? 'Sign-in failed.',
        );
    });
  }, []);

  const signIn = () => {
    const url = address.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    void window.overcli.invoke('org:signIn', { url }).then((res) => {
      if (!res.ok) {
        setBusy(false);
        setError(res.error);
        return;
      }
      try {
        patch({ orgServerUrl: new URL(url).origin });
      } catch {
        // validated in main
      }
      if (res.signedIn) {
        setBusy(false);
        refresh();
      } else {
        setPairing({ userCode: res.userCode, verifyUrl: res.verifyUrl });
      }
    }, (err: unknown) => {
      setBusy(false);
      setError(String(err));
    });
  };

  const who = status?.who;
  if (who && !pairing) {
    return (
      <Row label="Your org" help="Workers you build here can join the org from their Share card: Publish to your org.">
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <div className="text-sm text-ink">{who.org}</div>
            <div className="text-[11px] text-ink-muted">
              Signed in as {who.name}
              {who.canHire ? '. You can publish workers.' : '. You cannot hire yet; ask an admin.'}
            </div>
          </div>
          <button
            disabled={status?.fromEnv === true}
            onClick={() => {
              void window.overcli.invoke('org:signOut').then(() => {
                setStatus(null);
                refresh();
              });
            }}
            className="ml-auto text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-card-strong border border-card flex-shrink-0 disabled:opacity-40"
          >
            Sign out
          </button>
        </div>
        <div className="text-[10px] text-ink-faint font-mono">{local.orgServerUrl}</div>
      </Row>
    );
  }

  return (
    <>
      <Row
        label="Your org"
        help="Paste the invite link you were sent, or your org’s address. With an address, your browser opens to confirm it’s you; the app signs in when you do."
      >
        {pairing ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg tracking-widest text-ink" title="Pairing code">
                {pairing.userCode}
              </span>
              <span className="text-[11px] text-ink-muted" aria-live="polite">
                Check your browser shows this code, then press Allow. Waiting…
              </span>
            </div>
            <div className="flex gap-2">
              <a href={pairing.verifyUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                Open the page again
              </a>
              <button
                onClick={() => {
                  void window.overcli.invoke('org:cancelSignIn');
                  setPairing(null);
                  setBusy(false);
                }}
                className="text-xs text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="https://overcli.acme.example or an invite link"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') signIn();
              }}
              className="field flex-1 px-2 py-1 text-xs font-mono"
            />
            <button
              disabled={busy || !address.trim()}
              onClick={signIn}
              className="text-xs px-3 py-1 rounded bg-accent text-white flex-shrink-0 disabled:opacity-40"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="text-[10px] text-red-300">
            {error}
          </div>
        )}
        {status?.error && !pairing && <div className="text-[10px] text-red-300">{status.error}</div>}
      </Row>
      <details className="text-[11px] text-ink-faint">
        <summary className="cursor-pointer">Use a token instead</summary>
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            placeholder={status?.fromEnv ? 'set by $OVERCLI_ORG_TOKEN' : status?.tokenConfigured ? 'configured — type to replace' : 'ocli_…'}
            value={token}
            disabled={status?.fromEnv === true}
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => {
              if (!token.trim()) return;
              if (address.trim()) {
                try {
                  patch({ orgServerUrl: new URL(address.trim()).origin });
                } catch {
                  setError('That address is not a URL.');
                  return;
                }
              }
              void window.overcli.invoke('org:setToken', token.trim()).then((res) => {
                if (!res.ok) {
                  setError(res.error ?? 'Could not save the token.');
                  return;
                }
                setToken('');
                void window.overcli.invoke('org:status', address.trim() ? { url: address.trim() } : undefined).then(setStatus);
              });
            }}
            className="field flex-1 px-2 py-1 text-xs font-mono disabled:opacity-40"
          />
        </div>
      </details>
    </>
  );
}

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
  // The answer to "is this actually working?". Nothing else can tell you: a
  // webhook that silently stopped delivering looks exactly like a quiet week,
  // and you are by definition not at the machine to notice.
  const [delivery, setDelivery] = useState<{
    at: number;
    ok: boolean;
    error?: string;
    consecutiveFailures: number;
  } | null>(null);
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
    void window.overcli
      .invoke('notify:webhookDelivery')
      .then(setDelivery)
      .catch(() => setDelivery(null));
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
      help="Optional. overcli POSTs {text, title, body} as JSON here whenever it would otherwise only raise a desktop notification — a scheduled run that failed or finished, a worker's shift or errand, a budget exhaustion, a watch hit. The text key alone renders in a Slack incoming webhook with no extra setup; title/body keep it usable for any generic receiver. Leave blank to turn it off."
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
      {delivery && (
        <div className={'text-[10px] ' + (delivery.ok ? 'text-ink-faint' : 'text-red-300')}>
          {delivery.ok
            ? `Last notification delivered ${describeAgo(delivery.at)}.`
            : `${delivery.consecutiveFailures} notification${
                delivery.consecutiveFailures === 1 ? '' : 's'
              } failed to deliver, most recently ${describeAgo(delivery.at)} — ${delivery.error}`}
        </div>
      )}
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
    <Row
      label="Forward"
      help="Which notifications leave the machine. A channel that also carries every finished shift is a channel you end up muting — and a muted channel delivers the one message that mattered exactly as well as no webhook at all."
    >
      <select
        value={local.notificationWebhookFilter ?? 'all'}
        onChange={(e) => patch({ notificationWebhookFilter: e.target.value as 'all' | 'failures' })}
        className="field px-2 py-1 text-xs"
      >
        <option value="all">Everything</option>
        <option value="failures">Only failures</option>
      </select>
    </Row>
    </>
  );
}

/// What an org server is, for someone who hasn't turned it on: what changes,
/// what it takes, and the switch. Shown in Settings → Your org whether or
/// not the alpha is on, so it can be found without reading Labs.
function OrgIntro({ patch }: { patch: (p: Partial<AppSettings>) => void }) {
  const guide = 'https://github.com/overcodelions/overcli/blob/master/deploy/docs/getting-started.md';
  return (
    <div>
      <Group title="Your org · alpha" description="Run your workers for your whole team, not just on this Mac.">
        <div className="flex flex-col gap-4 text-sm text-ink">
          <ul className="flex flex-col gap-2 text-[13px] text-ink-muted list-disc pl-5">
            <li><span className="text-ink">Always on.</span> Workers keep their schedules when this Mac is asleep or closed.</li>
            <li><span className="text-ink">Your team can ask them</span> in Slack, from Claude, or on a web console, and give teams tasks.</li>
            <li><span className="text-ink">Managers stay in charge.</span> Each worker answers to someone, who approves its work in Slack or the console.</li>
            <li><span className="text-ink">Set up once for everyone:</span> keys, repos, tools and budgets live on the server.</li>
          </ul>
          <div className="text-[13px] text-ink-muted">
            <span className="text-ink">What it takes:</span> a server, which is Docker on any machine, AWS Fargate or Google Cloud Run. About ten minutes. The workers and teams you built here move over with Publish, and so does the rest of your setup.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => patch({ orgAlpha: true })} className="text-xs px-3 py-1.5 rounded bg-accent text-white">
              Turn it on
            </button>
            <a href={guide} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
              Read how to run one
            </a>
            <span className="text-[11px] text-ink-faint">Already have one? Turn it on, then sign in with the link you were sent.</span>
          </div>
        </div>
      </Group>
    </div>
  );
}

/// Publish my setup: this desktop's workspaces, projects and tools, picked
/// one by one, onto the org server. Nothing is ticked to start with. A
/// tool's keys only go when you tick "send its keys" for that tool, and the
/// server only takes them from an admin over https or on this machine.
function OrgSetupPublish() {
  type Preview = Extract<ReturnType<IPCInvokeMap['org:setupPreview']>, { ok: true }>;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spaces, setSpaces] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Set<string>>(new Set());
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    put(next);
  };
  const open = () => {
    setBusy(true);
    setError(null);
    setDone(null);
    void window.overcli.invoke('org:setupPreview').then((res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      else setPreview(res);
    });
  };
  const publish = () => {
    setBusy(true);
    setError(null);
    void window.overcli
      .invoke('org:publishSetup', { tools: [...tools], sendKeysFor: [...keys].filter((k) => tools.has(k)), workspaceIds: [...spaces], projectIds: [...projects] })
      .then((res) => {
        setBusy(false);
        if (!res.ok) setError(res.error);
        else {
          setDone(res.message);
          setPreview(null);
        }
      });
  };
  if (!preview) {
    return (
      <Row label="Publish my setup" help="Send the org server the workspaces, repos and tools you pick from this app, for its admin to install. Keys stay here unless you choose to send them.">
        <div className="flex flex-col gap-2">
          <button onClick={open} disabled={busy} className="self-start text-xs px-3 py-1.5 rounded border border-card text-ink hover:bg-card-strong disabled:opacity-50">
            {busy ? 'Reading your setup…' : 'Choose what to publish…'}
          </button>
          {done && <div className="text-[11px] text-ink-muted" role="status">{done}</div>}
          {error && <div className="text-[11px] text-red-400" role="alert">{error}</div>}
        </div>
      </Row>
    );
  }
  const inSpace = new Set(preview.workspaces.flatMap((w) => w.projectIds));
  const byId = new Map(preview.projects.map((p) => [p.id, p]));
  const loose = preview.projects.filter((p) => !inSpace.has(p.id));
  const chosen = spaces.size + projects.size + tools.size;
  const box = 'mt-0.5 flex-shrink-0';
  return (
    <div className="flex flex-col gap-4 rounded border border-card p-4">
      <div className="text-xs text-ink-muted">
        Publishing to <span className="font-mono">{preview.server}</span>. Pick what it should have; nothing is picked yet.
        {preview.sameMachine && ' That server runs on this Mac and already uses your tools and logins, so publishing there only tries the flow out.'}
      </div>
      {preview.workspaces.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Workspaces</div>
          {preview.workspaces.map((w) => (
            <label key={w.id} className="flex gap-2 text-sm text-ink">
              <input type="checkbox" className={box} checked={spaces.has(w.id)} onChange={() => toggle(spaces, setSpaces, w.id)} />
              <span className="min-w-0">
                {w.name}
                <span className="block text-[11px] text-ink-muted">
                  {w.projectIds.map((id) => byId.get(id)).filter(Boolean).map((p) => `${p!.name}${p!.url ? '' : ' (no remote)'}`).join(', ') || 'No projects'}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {loose.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">{preview.workspaces.length ? 'Other projects' : 'Projects'}</div>
          {loose.map((p) => (
            <label key={p.id} className="flex gap-2 text-sm text-ink">
              <input type="checkbox" className={box} checked={projects.has(p.id)} onChange={() => toggle(projects, setProjects, p.id)} />
              <span className="min-w-0">
                {p.name}
                <span className="block text-[11px] text-ink-muted font-mono truncate">{p.url ?? 'No git remote: only a server on this Mac can use it'}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {preview.tools.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Tools (MCP servers)</div>
          {preview.tools.map((t) => (
            <div key={t.name} className="flex flex-col gap-1">
              <label className="flex gap-2 text-sm text-ink">
                <input type="checkbox" className={box} checked={tools.has(t.name)} onChange={() => toggle(tools, setTools, t.name)} />
                <span className="min-w-0">
                  {t.name}
                  <span className="block text-[11px] text-ink-muted font-mono truncate">{t.target}</span>
                </span>
              </label>
              {t.keys.length > 0 && tools.has(t.name) && (
                <div className="ml-6 flex flex-col gap-1">
                  <label className={`flex gap-2 text-[12px] ${preview.admin ? 'text-ink' : 'text-ink-faint'}`}>
                    <input type="checkbox" className={box} disabled={!preview.admin} checked={keys.has(t.name)} onChange={() => toggle(keys, setKeys, t.name)} />
                    <span>
                      Send its keys too <span className="font-mono text-ink-muted">({t.keys.join(', ')})</span>
                      {!preview.admin && <span className="block text-[11px]">Only an admin can send keys. Without them, an admin adds them on the server.</span>}
                    </span>
                  </label>
                  {keys.has(t.name) && (
                    <div className="text-[11px] text-amber-400" role="note">
                      These keys will act as you for every worker on that server that uses {t.name}: whatever you can reach, they can. For a real deployment, make a service account or bot token for the org instead.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={publish} disabled={busy || chosen === 0} className="text-xs px-3 py-1.5 rounded bg-accent text-white disabled:opacity-40">
          {busy ? 'Publishing…' : 'Publish'}
        </button>
        <button onClick={() => setPreview(null)} className="text-xs px-2 py-1.5 rounded text-ink-muted hover:text-ink">
          Cancel
        </button>
        <span className="text-[11px] text-ink-faint">
          {chosen === 0 ? 'Tick what to send.' : `${spaces.size} workspace${spaces.size === 1 ? '' : 's'}, ${projects.size} project${projects.size === 1 ? '' : 's'}, ${tools.size} tool${tools.size === 1 ? '' : 's'}${keys.size ? `, keys for ${[...keys].filter((k) => tools.has(k)).length}` : ''}`}
        </span>
      </div>
      {error && <div className="text-[11px] text-red-400" role="alert">{error}</div>}
    </div>
  );
}

/// Everything for the org alpha in one place, shown only while it's on:
/// the server this app publishes to, and the desktop's own Slack bridge.
function OrgPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <Group
        title="Your org · alpha"
        description="Your org's overcli server, where shared workers run for the whole team. Publish a worker you built here to it from the worker's Share card."
      >
        <OrgServerField local={local} patch={patch} />
        <OrgSetupPublish />
        <OrgSetupGuide local={local} patch={patch} />
      </Group>
      <Group
        title="Slack · alpha"
        description="Workers on this machine DM their manager in Slack when they need an answer or an approval. Leave it off when your org's server runs the same Slack app: two bridges on one app take each other's replies."
      >
        <SlackField local={local} patch={patch} />
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
        description="Where overcli tells you a scheduled run failed or a worker finished a shift."
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
      <Group title="Terminal">
        <Toggle
          label="Use the system terminal"
          help="Logins, installs and “open a terminal here” run in the built-in terminal drawer (⌘J). Turn this on to open Terminal.app or PowerShell windows instead. Shift-click a terminal button for a one-off system window either way."
          value={local.useSystemTerminal === true}
          onChange={(v) => patch({ useSystemTerminal: v })}
        />
      </Group>
      <Group title="Layout" description="Tuning reserved for when the defaults don't fit.">
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
          label="Claude MCP debug logging"
          help="Launch the Claude CLI with `--debug mcp` so MCP server startup and registration diagnostics print to stderr. View them in the Debug sheet (enable “Show Debug button” above). Useful for diagnosing MCP issues like the permission broker failing to register in a crowded config. Noisy — leave off for normal use."
          value={local.claudeMcpDebug ?? false}
          onChange={(v) => patch({ claudeMcpDebug: v })}
        />
        <Toggle
          label="Claude Design and artifacts (experimental)"
          help="Sets CLAUDE_CODE_ARTIFACT on Claude launches, which unlocks the Artifact tool and the /design canvas skill — both are otherwise switched off in the headless sessions overcli drives, and /design just answers with its usage line. Needs a claude.ai login (not an API key); some accounts are gated regardless. The Artifact tool publishes to claude.ai, so leave permission prompts on for it."
          value={local.claudeArtifacts ?? false}
          onChange={(v) => patch({ claudeArtifacts: v })}
        />
        <Toggle
          label="Claude in Chrome"
          help="Default for new and untouched conversations: launch Claude with `--chrome` so it can drive a real browser tab through the Claude in Chrome extension — clicking, filling forms, reading pages. Needs the Claude in Chrome extension installed and enabled in the Chrome profile you actually browse in, signed in to the same Claude account. This is the fallback only — each conversation has its own Chrome picker in the header that overrides it, so leaving this off still lets you switch it on per chat. This default applies to Claude conversations only. Codex can't use the extension; give it a browser MCP such as Puppeteer from Extensions. Flow runs use their per-run switch, and a worker's errands and runs start with it on when the worker has Browse the web ticked."
          value={local.claudeChrome ?? false}
          onChange={(v) => patch({ claudeChrome: v })}
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

/// Services settings. Whether the feature exists at all is switched in Labs
/// with the other "off until you want it" surfaces; most projects have
/// nothing to run, and a tab that is permanently empty is clutter.
function ServicesSettingsPane({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  return (
    <div className="space-y-5">
      {!local.servicesEnabled && (
        <LabOffNotice
          text="The Services tab is switched off in Labs. Overcli suggests it on any project that has something to run."
          action="Show the tab"
          onTurnOn={() => patch({ servicesEnabled: true })}
        />
      )}
      <Group title="Services">
        <Toggle
          label="Stop everything when overcli quits"
          help="On by default: a service left running holds its port, and there is no easy way to find the process afterwards. Turn it off if you deliberately keep something like a database up between sessions."
          value={local.servicesStopOnQuit !== false}
          onChange={(v) => patch({ servicesStopOnQuit: v })}
        />
      </Group>
    </div>
  );
}

/// Every lab spelled out, with `change` applied. Writing the full set keeps
/// an install from before Labs (where absent means on) from quietly turning
/// the rest off when one switch is flipped.
function allLabs(labs: AppSettings['labs'], change: Partial<Record<LabKey, boolean>>) {
  return { ...Object.fromEntries(LABS.map(({ key }) => [key, labOn(labs, key)])), ...change };
}

/// Top of a settings page whose feature is switched off in Labs: say so, and
/// offer the switch here rather than sending someone to find it.
function LabOffNotice({
  text,
  action,
  onTurnOn,
}: {
  text: string;
  action: string;
  onTurnOn: () => void;
}) {
  return (
    <div className="mb-5 flex items-center gap-3 rounded-lg border border-card-strong bg-card px-3 py-2.5">
      <div className="flex-1 text-xs text-ink-muted leading-relaxed">{text}</div>
      <SheetActionButton primary label={action} onClick={onTurnOn} />
    </div>
  );
}

/// Labs: whole surfaces a newcomer is better off not meeting on day one.
function LabsPane({
  local,
  patch,
}: {
  local: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  return (
    <div className="space-y-5">
      <Group
        title="Labs"
        description="The parts of overcli for once you know what you want from it. Turning one off only hides it; nothing it made is removed, and anything running keeps running."
      >
        {LABS.map((lab) => (
          <Toggle
            key={lab.key}
            label={lab.label}
            help={lab.help}
            value={labOn(local.labs, lab.key)}
            onChange={(v) => patch({ labs: allLabs(local.labs, { [lab.key]: v }) })}
          />
        ))}
        {/* Services keeps its own long-standing setting — off for everyone
            until asked for, unlike the labs above — but is switched here so
            every "off until you want it" surface lives in one place. */}
        <Toggle
          label="Org workers · alpha"
          help="Very early. Workers for a whole team: a server that runs them, managers asked in Slack, a web console, and publishing workers you build here to it. Adds a Your org section to Settings, and Manager and Who may ask it to each worker. Expect rough edges and changes."
          value={local.orgAlpha ?? false}
          onChange={(v) => patch({ orgAlpha: v })}
        />
        <Toggle
          label="Services"
          help="Lets overcli start and stop the things your projects run — a server, a web app, a database — and point them at whichever branch you are working on. Overcli also suggests it on a project that has something to run."
          value={local.servicesEnabled ?? false}
          onChange={(v) => patch({ servicesEnabled: v })}
        />
      </Group>
      {/* Not a lab: labs are surfaces that default on when unset, and this
          is an engine switch that must default off. It lives here because
          it is the same promise — try it if you want, expect rough edges. */}
      <Group
        title="Experimental"
        description="Alternative ways of running things. Off by default and not kept in step with the default path; new features land there first."
      >
        <Toggle
          label="Run Claude through the Agent SDK"
          help="Drives Claude turns in-process through the Claude Agent SDK instead of spawning `claude -p`. A fallback in case `-p` is ever restricted; use the default unless you are testing it."
          value={(local.claudeTransport ?? 'cli') === 'sdk'}
          onChange={(v) => patch({ claudeTransport: v ? 'sdk' : 'cli' })}
        />
      </Group>
    </div>
  );
}

function FlowsPane({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Group title="Run behavior">
        <Toggle
          label="Run flows in a worktree by default"
          help="Starts the launcher's run-in toggle on “worktree”, so a flow forks a fresh worktree off the base branch instead of working in the project's main tree. You can still flip it per run."
          value={(local.defaultFlowRunIn ?? 'worktree') === 'worktree'}
          onChange={(v) => patch({ defaultFlowRunIn: v ? 'worktree' : 'cwd' })}
        />
        <Toggle
          label="Sandbox flow writes"
          help="macOS only. Each flow step's agent runs in an OS sandbox that lets it write only its run's folder, the repo's git data (not hooks or config), temp folders and its own CLI state. A write anywhere else — your home folder, another project — fails with “Operation not permitted”, whatever the step's permission mode. Chat is never sandboxed."
          value={local.sandboxFlowWrites !== false}
          onChange={(v) => patch({ sandboxFlowWrites: v })}
        />
        <Row
          label="Cost ceiling per run"
          help="Stop a single run once it has spent this much, and notify. Leave empty for no ceiling. This is a stop-loss rather than a hard cap — cost is only known once a turn reports, so one very expensive turn can overshoot. Separate from the workers' monthly treasury, which only decides whether a new shift may start."
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-faint">$</span>
            <input
              type="number"
              min="0"
              step="0.5"
              placeholder="No ceiling"
              value={local.maxRunCostUSD ?? ''}
              onChange={(e) => {
                // An empty field means "no ceiling", which is `undefined` and
                // NOT 0 — storing 0 would read identically to the runtime but
                // render as a literal `0` in the box, which looks like a
                // ceiling of nothing rather than no ceiling at all.
                const raw = e.target.value.trim();
                if (raw === '') {
                  patch({ maxRunCostUSD: undefined });
                  return;
                }
                const parsed = Number(raw);
                if (Number.isFinite(parsed) && parsed >= 0) patch({ maxRunCostUSD: parsed });
              }}
              className="field w-28 px-2 py-1 text-xs"
            />
          </div>
        </Row>
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
