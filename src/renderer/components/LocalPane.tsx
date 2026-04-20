import { useEffect, useMemo, useRef, useState } from 'react';
import {
  OllamaDetectionReport,
  OllamaHardwareReport,
  OllamaRecommendedModel,
  OllamaServerLogLine,
  OllamaServerStatus,
} from '@shared/types';

/// Top-level Ollama dashboard. Sibling to Chat/Usage. Handles the whole
/// local-LLM lifecycle — install prompt, server start/stop with a live
/// log view, hardware-aware model suggestions, and the list of pulled
/// models. Chat itself still happens through the regular conversation
/// pane; this page is the control plane.
export function LocalPane() {
  const [detection, setDetection] = useState<OllamaDetectionReport | null>(null);
  const [hardware, setHardware] = useState<OllamaHardwareReport | null>(null);
  const [catalog, setCatalog] = useState<OllamaRecommendedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverStatus, setServerStatus] = useState<OllamaServerStatus>('stopped');
  const [serverLog, setServerLog] = useState<OllamaServerLogLine[]>([]);
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [pulls, setPulls] = useState<
    Record<string, { percent: number; message?: string; done?: boolean; error?: string }>
  >({});
  const [countryFilter, setCountryFilter] = useState<string | 'all'>('all');
  const [companyFilter, setCompanyFilter] = useState<string | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    const [det, hw, srv, cat] = await Promise.all([
      window.overcli.invoke('ollama:detect'),
      window.overcli.invoke('ollama:hardware'),
      window.overcli.invoke('ollama:serverStatus'),
      window.overcli.invoke('ollama:catalog'),
    ]);
    setDetection(det);
    setHardware(hw);
    setServerStatus(srv.status);
    setServerLog(srv.log);
    setCatalog(cat);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    const off = window.overcli.onMainEvent((ev) => {
      if (ev.type === 'ollamaServerLog') {
        setServerLog((log) => {
          const next = [...log, ev.line];
          if (next.length > 500) next.splice(0, next.length - 500);
          return next;
        });
      } else if (ev.type === 'ollamaServerStatus') {
        setServerStatus(ev.status);
        // Status flip → models may have changed (e.g. server just came
        // online and we can now list tags).
        void refresh();
      } else if (ev.type === 'ollamaPull') {
        const e = ev.event;
        setPulls((prev) => {
          const next = { ...prev };
          if (e.type === 'progress') {
            next[e.tag] = { percent: e.percent, message: e.message };
          } else if (e.type === 'status') {
            next[e.tag] = { percent: prev[e.tag]?.percent ?? 0, message: e.message };
          } else {
            next[e.tag] = { percent: 100, done: true, error: e.success ? undefined : e.message };
            if (e.success) void refresh();
          }
          return next;
        });
      }
    });
    return off;
  }, []);

  // Poll detection while the server hasn't reported running yet, so we
  // catch external-start cases (user launched Ollama.app).
  useEffect(() => {
    if (serverStatus === 'running' && detection?.installed && detection.running) {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = window.setInterval(() => void refresh(), 4000) as unknown as number;
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [serverStatus, detection?.installed, detection?.running]);

  const installedTags = useMemo(
    () => new Set(detection?.models?.map((m) => m.name) ?? []),
    [detection],
  );

  const install = async () => {
    setInstallStatus('Starting…');
    const res = await window.overcli.invoke('ollama:install');
    setInstallStatus(
      res.started === 'brew'
        ? res.detail ?? 'Opened Terminal with the install command.'
        : 'Opened the Ollama download page in your browser.',
    );
    setTimeout(() => void refresh(), 1500);
  };

  const startServer = async () => {
    const res = await window.overcli.invoke('ollama:startServer');
    setInstallStatus(res.message);
  };

  const stopServer = () => {
    void window.overcli.invoke('ollama:stopServer');
  };

  const pullModel = (tag: string) => {
    setPulls((p) => ({ ...p, [tag]: { percent: 0 } }));
    void window.overcli.invoke('ollama:pullModel', { tag });
  };

  const cancelPull = (tag: string) => {
    void window.overcli.invoke('ollama:cancelPull', { tag });
  };

  const deleteModel = async (tag: string) => {
    setDeleting(tag);
    setDeleteError(null);
    const res = await window.overcli.invoke('ollama:deleteModel', { tag });
    setDeleting(null);
    setConfirmDelete(null);
    if (!res.ok) {
      setDeleteError(`${tag}: ${res.error}`);
    } else {
      void refresh();
    }
  };

  if (loading) {
    return <div className="p-8 text-ink-muted text-sm">Detecting Ollama…</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="text-2xl font-semibold">Local models</div>
        <StatusPill detection={detection} serverStatus={serverStatus} />
        <button
          onClick={() => void refresh()}
          className="text-xs text-ink-muted hover:text-ink ml-auto hover:bg-card px-2 py-1 rounded"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Server card */}
      <Card>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium mb-1">Ollama server</div>
            <div className="text-xs text-ink-muted">
              {detection?.installed ? (
                <>
                  {detection.running
                    ? `Running on 127.0.0.1:11434${detection.version ? ` · v${detection.version}` : ''}`
                    : 'Installed but not running. Start it to chat with local models.'}
                </>
              ) : (
                <>Ollama isn't installed yet. OverCLI can kick off the install — nothing is bundled.</>
              )}
            </div>
            {installStatus && (
              <div className="text-[11px] text-ink-faint mt-1">{installStatus}</div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            {!detection?.installed ? (
              <button
                onClick={() => void install()}
                className="text-xs px-3 py-1 rounded bg-accent/15 text-accent hover:bg-accent/25"
              >
                Install Ollama
              </button>
            ) : serverStatus === 'running' || detection.running ? (
              <button
                onClick={stopServer}
                className="text-xs px-3 py-1 rounded bg-card/70 text-ink-muted hover:bg-card hover:text-ink"
              >
                Stop server
              </button>
            ) : (
              <button
                onClick={() => void startServer()}
                disabled={serverStatus === 'starting'}
                className="text-xs px-3 py-1 rounded bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                {serverStatus === 'starting' ? 'Starting…' : 'Start server'}
              </button>
            )}
          </div>
        </div>

        <LogViewer log={serverLog} />
      </Card>

      {/* Hardware card */}
      {hardware && (
        <Card title="This machine" description="We use these specs to suggest models that will run smoothly.">
          <div className="grid grid-cols-2 gap-y-1 gap-x-6 text-xs">
            <Fact label="RAM" value={`${hardware.totalRamGB} GB`} />
            <Fact label="CPU" value={hardware.cpuModel} />
            {hardware.gpu && <Fact label="GPU" value={hardware.gpu} />}
            <Fact label="Tier" value={hardware.recommendedTier} />
          </div>
        </Card>
      )}

      {/* Recommended models */}
      {detection?.installed && hardware && (
        <Card
          title="Recommended models"
          description="Tailored to your hardware. Licenses are shown per-model — you accept them when you pull."
        >
          <div className="flex flex-col gap-2">
            {hardware.recommendedModels.map((m) => (
              <ModelRow
                key={m.tag}
                model={m}
                installed={installedTags.has(m.tag)}
                pullState={pulls[m.tag]}
                onPull={() => pullModel(m.tag)}
                onCancel={() => cancelPull(m.tag)}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Browse full catalog */}
      {detection?.installed && catalog.length > 0 && (
        <Card
          title="Browse models"
          description="Curated catalog with maker and country of origin. Not exhaustive — any Ollama tag still pulls via the CLI."
        >
          <CatalogFilters
            catalog={catalog}
            country={countryFilter}
            company={companyFilter}
            onCountry={setCountryFilter}
            onCompany={setCompanyFilter}
          />
          <div className="flex flex-col gap-2 mt-3">
            {filterCatalog(catalog, countryFilter, companyFilter).map((m) => (
              <ModelRow
                key={m.tag}
                model={m}
                installed={installedTags.has(m.tag)}
                pullState={pulls[m.tag]}
                onPull={() => pullModel(m.tag)}
                onCancel={() => cancelPull(m.tag)}
              />
            ))}
            {filterCatalog(catalog, countryFilter, companyFilter).length === 0 && (
              <div className="text-[11px] text-ink-faint">No models match the current filters.</div>
            )}
          </div>
        </Card>
      )}

      {/* Installed models */}
      {detection?.installed && detection.models.length > 0 && (
        <Card title="Installed models">
          <div className="flex flex-col gap-1 text-xs">
            {detection.models.map((m) => {
              const isConfirming = confirmDelete === m.name;
              const isDeleting = deleting === m.name;
              return (
                <div
                  key={m.name}
                  className="flex items-center justify-between gap-3 py-1 px-2 rounded hover:bg-card-strong"
                >
                  <span className="font-mono text-ink flex-1 truncate">{m.name}</span>
                  <span className="text-ink-faint">{formatBytes(m.sizeBytes)}</span>
                  {isConfirming ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => void deleteModel(m.name)}
                        disabled={isDeleting}
                        className="text-[11px] px-2 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-50"
                      >
                        {isDeleting ? 'Removing…' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        disabled={isDeleting}
                        className="text-[11px] px-2 py-0.5 rounded bg-card/70 text-ink-muted hover:bg-card hover:text-ink disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setDeleteError(null);
                        setConfirmDelete(m.name);
                      }}
                      className="text-[11px] px-2 py-0.5 rounded bg-card/70 text-ink-muted hover:bg-card hover:text-red-300"
                      title="Remove this model from disk"
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {deleteError && (
            <div className="text-xs text-red-300 mt-2">Error: {deleteError}</div>
          )}
        </Card>
      )}

      <div className="text-[11px] text-ink-faint leading-relaxed mt-4">
        OverCLI does not ship or redistribute any model weights. Each model you pull
        is downloaded directly from Ollama and subject to its own license. Review the
        terms before using a model commercially.
      </div>
    </div>
  );
}

function StatusPill({
  detection,
  serverStatus,
}: {
  detection: OllamaDetectionReport | null;
  serverStatus: OllamaServerStatus;
}) {
  if (!detection) return null;
  if (!detection.installed) {
    return <Pill tone="red">not installed</Pill>;
  }
  if (detection.running || serverStatus === 'running') {
    return <Pill tone="green">ready</Pill>;
  }
  if (serverStatus === 'starting') {
    return <Pill tone="amber">starting…</Pill>;
  }
  if (serverStatus === 'error') {
    return <Pill tone="red">error</Pill>;
  }
  return <Pill tone="amber">server off</Pill>;
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red'; children: React.ReactNode }) {
  const map = {
    green: 'bg-green-500/20 text-green-300',
    amber: 'bg-amber-500/20 text-amber-300',
    red: 'bg-red-500/20 text-red-300',
  };
  return <span className={`text-[10px] px-2 py-0.5 rounded ${map[tone]}`}>{children}</span>;
}

function Card({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      {title && (
        <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">{title}</div>
      )}
      {description && <div className="text-xs text-ink-faint mb-2">{description}</div>}
      <div className="rounded-lg bg-card border border-card p-4">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="text-ink-faint">{label}</div>
      <div className="text-ink">{value}</div>
    </>
  );
}

function LogViewer({ log }: { log: OllamaServerLogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Auto-scroll to bottom when new lines arrive, unless the user has
    // scrolled up to inspect earlier output.
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (log.length === 0) {
    return (
      <div className="mt-3 text-[11px] text-ink-faint italic">
        Server log will appear here once you start the server.
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="mt-3 h-[200px] overflow-y-auto rounded bg-[#0b0b0e] border border-card-strong p-2 font-mono text-[11px] leading-snug"
    >
      {log.map((line, i) => (
        <div
          key={i}
          className={
            line.stream === 'stderr'
              ? 'text-amber-300'
              : line.stream === 'system'
              ? 'text-accent'
              : 'text-ink-muted'
          }
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

function formatReleasedAt(ym: string): string {
  // Expected YYYY-MM; render as "MMM YYYY" (e.g. "2024-11" → "Nov 2024").
  // If the string doesn't match, fall through and show it as-is so a
  // future format (YYYY-MM-DD, say) still reads sensibly.
  const match = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!match) return ym;
  const year = match[1];
  const monthIdx = Number.parseInt(match[2], 10) - 1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (monthIdx < 0 || monthIdx > 11) return ym;
  return `${months[monthIdx]} ${year}`;
}

function countryLabel(code: string): string {
  switch (code) {
    case 'US':
      return '🇺🇸 US';
    case 'CN':
      return '🇨🇳 China';
    case 'FR':
      return '🇫🇷 France';
    case 'EU':
      return '🇪🇺 EU';
    case 'UK':
      return '🇬🇧 UK';
    default:
      return code;
  }
}

function filterCatalog(
  catalog: OllamaRecommendedModel[],
  country: string,
  company: string,
): OllamaRecommendedModel[] {
  return catalog.filter(
    (m) => (country === 'all' || m.country === country) && (company === 'all' || m.company === company),
  );
}

function CatalogFilters({
  catalog,
  country,
  company,
  onCountry,
  onCompany,
}: {
  catalog: OllamaRecommendedModel[];
  country: string;
  company: string;
  onCountry: (value: string) => void;
  onCompany: (value: string) => void;
}) {
  const countries = useMemo(
    () => Array.from(new Set(catalog.map((m) => m.country))).sort(),
    [catalog],
  );
  // Companies available under the current country filter — keeps the
  // dropdown from listing makers whose entries would all be filtered out.
  const companies = useMemo(
    () =>
      Array.from(
        new Set(catalog.filter((m) => country === 'all' || m.country === country).map((m) => m.company)),
      ).sort(),
    [catalog, country],
  );
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px]">
      <label className="flex items-center gap-1.5 text-ink-faint">
        Country
        <select
          value={country}
          onChange={(e) => {
            onCountry(e.target.value);
            onCompany('all');
          }}
          className="bg-card border border-card-strong rounded px-1.5 py-0.5 text-ink"
        >
          <option value="all">All</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {countryLabel(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-ink-faint">
        Company
        <select
          value={company}
          onChange={(e) => onCompany(e.target.value)}
          className="bg-card border border-card-strong rounded px-1.5 py-0.5 text-ink"
        >
          <option value="all">All</option>
          {companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ModelRow({
  model,
  installed,
  pullState,
  onPull,
  onCancel,
}: {
  model: OllamaRecommendedModel;
  installed: boolean;
  pullState?: { percent: number; message?: string; done?: boolean; error?: string };
  onPull: () => void;
  onCancel: () => void;
}) {
  const pulling = !!pullState && !pullState.done;
  return (
    <div className="flex flex-col gap-1 p-2.5 rounded bg-card/60">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="text-sm text-ink flex items-center gap-2 flex-wrap">
            <span>
              {model.displayName}{' '}
              <span className="text-ink-muted font-mono text-xs">· {model.tag}</span>
            </span>
            {model.supportsTools && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium"
                title="This model supports tool calling — it can read files, run searches, and take other actions you wire up."
              >
                Tools
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            ~{model.sizeGB} GB · {model.license} · {model.company} ({countryLabel(model.country)})
            {model.releasedAt && ` · released ${formatReleasedAt(model.releasedAt)}`}
            {model.note && ` · ${model.note}`}
          </div>
        </div>
        {installed ? (
          <Pill tone="green">installed</Pill>
        ) : pulling ? (
          <button
            onClick={onCancel}
            className="text-xs px-2.5 py-1 rounded bg-card/70 text-ink-muted hover:bg-card hover:text-ink"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onPull}
            className="text-xs px-2.5 py-1 rounded bg-accent/15 text-accent hover:bg-accent/25"
          >
            Pull
          </button>
        )}
      </div>
      {pulling && (
        <div className="flex flex-col gap-0.5">
          <div className="h-1 rounded bg-card overflow-hidden">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${pullState!.percent}%` }}
            />
          </div>
          <div className="text-xs text-ink-muted">
            {pullState!.message ?? 'Starting…'} · {pullState!.percent}%
          </div>
        </div>
      )}
      {pullState?.error && (
        <div className="text-xs text-red-300">Error: {pullState.error}</div>
      )}
    </div>
  );
}
