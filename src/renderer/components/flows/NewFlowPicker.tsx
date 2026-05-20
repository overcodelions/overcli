// Modal-style picker shown when the user clicks "+ New flow". Three
// entries: choose a curated template, describe a flow and have Claude
// draft it, or start blank. Lives inline in the flows pane rather than
// the global SheetHost to keep the entry-point flow self-contained.

import { useEffect, useState, type ReactNode } from 'react';

import type { Flow, FlowStep } from '@shared/flows/schema';
import { parseFlowYaml } from '@shared/flows/yaml';
import type { FlowTemplate, FlowTemplateIcon } from '@shared/flows/templates';
import { resolveTemplateForUser } from '@shared/flows/templateResolver';
import { pickDrafterBackend, drafterModelFor } from '@shared/flows/drafterBackend';
import { friendlyModelLabel } from '@shared/modelCatalog';
import type { Backend } from '@shared/types';
import { backendName } from '../../theme';
import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';

export function NewFlowPicker({ onClose }: { onClose: () => void }) {
  const openEditor = useFlowsStore((s) => s.openEditor);
  const backendHealth = useStore((s) => s.backendHealth);
  const settings = useStore((s) => s.settings);
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [mode, setMode] = useState<'menu' | 'ai'>('menu');

  // Which CLI will the "Describe a flow" drafter actually use? Resolved the
  // same way the main-process drafter resolves it, so the copy below names
  // the backend that really runs.
  const drafterBackend = pickDrafterBackend({
    preferred: settings.preferredBackend,
    isHealthy: (b) => backendHealth[b]?.kind === 'ready',
    isEnabled: (b) => settings.disabledBackends?.[b] !== true,
  });
  const drafterName = drafterBackend ? backendName(drafterBackend) : 'your preferred CLI';
  const drafterModelLabel = drafterBackend
    ? friendlyModelLabel(drafterBackend, drafterModelFor(drafterBackend))
    : null;

  useEffect(() => {
    void window.overcli
      .invoke('flows:listTemplates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
    // Pull installed ollama models so the resolver can prefer them for
    // fast-tier steps. Detection is cheap (cached after the first call)
    // and we don't block render on it — until it arrives the resolver
    // just falls back to premium fast models.
    void window.overcli
      .invoke('ollama:detect')
      .then((r) => {
        setOllamaModels(r.running ? r.models.map((m) => m.name) : []);
      })
      .catch(() => setOllamaModels([]));
  }, []);

  function startFromTemplate(t: FlowTemplate) {
    const parsed = parseFlowYaml({
      yaml: t.yaml,
      id: t.id,
      source: 'user',
      filePath: '',
    });
    if (!parsed) return;
    const healthyBackends = (Object.keys(backendHealth) as Backend[]).filter(
      (b) => backendHealth[b]?.kind === 'ready',
    );
    const rebound = resolveTemplateForUser(parsed, { healthyBackends, ollamaModels });
    openEditor({ kind: 'new' }, freshFlow(rebound, t.id));
    onClose();
  }

  function startBlank() {
    openEditor({ kind: 'new' });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[760px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card">
          <div className="text-lg font-semibold">New flow</div>
          {mode === 'ai' && (
            <button
              onClick={() => setMode('menu')}
              className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
            >
              ← Back
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {mode === 'menu' && (
            <>
              {/* Top entries */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                <BigChoice
                  icon={<SparkleIcon />}
                  title="Describe a flow"
                  subtitle={`Tell ${drafterName} what you want and it'll draft a flow for you.`}
                  onClick={() => setMode('ai')}
                />
                <BigChoice
                  icon={<PageIcon />}
                  title="Start blank"
                  subtitle="One step. Configure everything yourself."
                  onClick={startBlank}
                />
              </div>

              {/* Templates */}
              <div className="text-xs uppercase tracking-wider text-ink-faint mb-2">
                Or start from a template
              </div>
              <div className="grid grid-cols-2 gap-3">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => startFromTemplate(t)}
                    className="text-left rounded-lg border border-card bg-card/30 p-4 hover:bg-card/60 hover:border-card-strong transition"
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-ink-muted mt-0.5 flex-shrink-0">
                        <TemplateIcon kind={t.icon} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold mb-1">{t.name}</div>
                        <div className="text-xs text-ink-muted">{t.description}</div>
                      </div>
                    </div>
                  </button>
                ))}
                {templates.length === 0 && (
                  <div className="col-span-2 text-sm text-ink-faint">Loading templates…</div>
                )}
              </div>
            </>
          )}

          {mode === 'ai' && (
            <AIDraft onDone={onClose} drafterName={drafterName} drafterModelLabel={drafterModelLabel} />
          )}
        </div>
      </div>
    </div>
  );
}

function BigChoice({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-lg border border-card bg-card/30 p-4 hover:bg-card/60 hover:border-accent transition"
    >
      <div className="text-ink-muted mb-2">{icon}</div>
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="text-xs text-ink-muted">{subtitle}</div>
    </button>
  );
}

/// Dispatches a template icon key to its stroked SVG glyph. 20px viewBox
/// keeps the optical weight close to the sidebar's 16px icons while still
/// reading on a 4xl modal card. Falls back to PageIcon if the renderer
/// receives an unknown key — keeps cards visually intact across version
/// skew between main and renderer.
function TemplateIcon({ kind }: { kind: FlowTemplateIcon }) {
  switch (kind) {
    case 'spark-plus':
      return <SparkPlusIcon />;
    case 'target':
      return <TargetIcon />;
    case 'magnifier':
      return <MagnifierIcon />;
    case 'beaker':
      return <BeakerIcon />;
    case 'refresh':
      return <RefreshIcon />;
    case 'book':
      return <BookIcon />;
    case 'compass':
      return <CompassIcon />;
    default:
      return <PageIcon />;
  }
}

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function SparkPlusIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M8 2.5 L9.3 6.2 L13 7.5 L9.3 8.8 L8 12.5 L6.7 8.8 L3 7.5 L6.7 6.2 Z" />
      <path d="M14 12 V17 M11.5 14.5 H16.5" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="3.5" />
      <circle cx="10" cy="10" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MagnifierIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.5 12.5 L16.5 16.5" />
    </svg>
  );
}

function BeakerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M7.5 2.5 H12.5 M8.5 2.5 V8 L4.5 15.5 A1.2 1.2 0 0 0 5.6 17.3 H14.4 A1.2 1.2 0 0 0 15.5 15.5 L11.5 8 V2.5" />
      <path d="M6.3 12 H13.7" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3.5 10 A6.5 6.5 0 0 1 14.8 5.7" />
      <path d="M15 3 V6 H12" />
      <path d="M16.5 10 A6.5 6.5 0 0 1 5.2 14.3" />
      <path d="M5 17 V14 H8" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="10" r="6.8" />
      <path d="M12.6 7.4 L9.2 9.2 L7.4 12.6 L10.8 10.8 Z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3.5 4.5 H8.5 A1.5 1.5 0 0 1 10 6 V16.5 A1.2 1.2 0 0 0 8.8 15.3 H3.5 Z" />
      <path d="M16.5 4.5 H11.5 A1.5 1.5 0 0 0 10 6 V16.5 A1.2 1.2 0 0 1 11.2 15.3 H16.5 Z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M10 2.5 L11.7 7.5 L16.5 9.2 L11.7 10.9 L10 16 L8.3 10.9 L3.5 9.2 L8.3 7.5 Z" />
      <path d="M16 3 L16.6 4.5 L18 5 L16.6 5.5 L16 7 L15.4 5.5 L14 5 L15.4 4.5 Z" />
    </svg>
  );
}

function PageIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M5 2.5 H11.5 L15 6 V16.5 A1 1 0 0 1 14 17.5 H5 A1 1 0 0 1 4 16.5 V3.5 A1 1 0 0 1 5 2.5 Z" />
      <path d="M11.5 2.5 V6 H15" />
    </svg>
  );
}

function AIDraft({
  onDone,
  drafterName,
  drafterModelLabel,
}: {
  onDone: () => void;
  drafterName: string;
  drafterModelLabel: string | null;
}) {
  const openEditor = useFlowsStore((s) => s.openEditor);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDraft() {
    if (!description.trim()) {
      setError(`Tell ${drafterName} what you want the flow to do first.`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.overcli.invoke('flows:draftFromPrompt', { description });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      openEditor({ kind: 'new' }, result.flow);
      onDone();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="text-sm font-semibold mb-2">Describe what you want</div>
      <div className="text-xs text-ink-muted mb-3">
        Be concrete about inputs, the kind of work, and where you want a human checkpoint.
        Examples that work well:
        <ul className="list-disc list-inside mt-1 space-y-0.5">
          <li>"Fix a Jira ticket I paste in, then open a PR — let me review before pushing."</li>
          <li>"Look at my staged changes and write tests for them locally."</li>
          <li>"Refactor a function with a premium plan, build it locally, verify with a critic."</li>
        </ul>
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={6}
        disabled={loading}
        placeholder="e.g. Fix a Jira ticket and open a PR…"
        className="w-full bg-card border border-card-strong rounded p-3 text-sm"
        autoFocus
      />
      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-3 mt-2">
          {error}
        </div>
      )}
      <div className="flex justify-end mt-3">
        <button
          onClick={handleDraft}
          disabled={loading}
          className="text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Drafting…' : '✨ Draft this flow'}
        </button>
      </div>
      <div className="text-[11px] text-ink-faint mt-2">
        {drafterModelLabel ? `Uses ${drafterModelLabel}. ` : ''}You'll be dropped into the editor
        with the result so you can tweak.
      </div>
    </div>
  );
}

/// Clone the parsed template into a fresh flow object for the editor.
/// Strips file path + sets source to 'user' so saving lands in user-global
/// by default. Preserves the original template id but the user can change
/// it before save.
function freshFlow(flow: Flow, idHint: string): Flow {
  const cloned: Flow = JSON.parse(JSON.stringify(flow));
  cloned.id = idHint;
  cloned.source = 'user';
  cloned.filePath = '';
  // Strip any step pause_before set on the FIRST step (templates shouldn't
  // ship with that but defensive check — validation flags it as well).
  if (cloned.steps[0]) {
    const first = cloned.steps[0] as FlowStep;
    if (first.pauseBefore) first.pauseBefore = undefined;
  }
  return cloned;
}
