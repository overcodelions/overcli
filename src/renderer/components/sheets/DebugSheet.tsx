import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import type { SilentLogEntry, StreamEvent } from '../../../shared/types';

type Tab = 'stream' | 'diagnostics';

export function DebugSheet() {
  const selectedId = useStore((s) => s.selectedConversationId);
  const runner = useStore((s) => (selectedId ? s.runners[selectedId] : null));
  const events = runner?.events ?? [];

  const [tab, setTab] = useState<Tab>('stream');
  const [query, setQuery] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.kind.type, (m.get(e.kind.type) ?? 0) + 1);
    return m;
  }, [events]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeTypes.size > 0 && !activeTypes.has(e.kind.type)) return false;
      if (q && !e.raw.toLowerCase().includes(q) && !e.kind.type.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, query, activeTypes]);

  const toggleType = (t: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isExpanded = (id: string) => allExpanded || expanded.has(id);

  const expandAll = () => {
    setAllExpanded(true);
    setExpanded(new Set());
  };
  const collapseAll = () => {
    setAllExpanded(false);
    setExpanded(new Set());
  };
  const copyAll = () => {
    const text = filtered
      .map((e) => {
        const time = new Date(e.timestamp).toISOString().slice(11, 23);
        return `[${time}] ${e.kind.type}\n${e.raw}`;
      })
      .join('\n\n');
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1200);
  };

  return (
    <div className="flex flex-col max-h-[85vh] min-h-[60vh]">
      <div className="px-5 pt-4 pb-2 border-b border-card flex items-center gap-3 text-xs">
        <button
          onClick={() => setTab('stream')}
          className={
            'px-2 py-1 rounded font-medium transition-colors ' +
            (tab === 'stream' ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
          }
        >
          Stream
        </button>
        <button
          onClick={() => setTab('diagnostics')}
          className={
            'px-2 py-1 rounded font-medium transition-colors ' +
            (tab === 'diagnostics' ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
          }
        >
          Diagnostics
        </button>
      </div>
      {tab === 'diagnostics' ? <DiagnosticsTab /> : (
      <>
      <div className="px-5 pt-4 pb-3 border-b border-card">
        <div className="flex items-baseline justify-between mb-2">
          <div>
            <div className="text-lg font-semibold">Debug stream</div>
            <div className="text-xs text-ink-faint">
              {filtered.length === events.length
                ? `${events.length} event${events.length === 1 ? '' : 's'}`
                : `${filtered.length} of ${events.length} events`}
            </div>
          </div>
          <div className="flex gap-2 text-[11px]">
            <button
              onClick={expandAll}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
            >
              expand all
            </button>
            <button
              onClick={collapseAll}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
            >
              collapse all
            </button>
            <button
              onClick={copyAll}
              disabled={filtered.length === 0}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedAll ? 'copied' : 'copy all'}
            </button>
          </div>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search event content or type…"
          className="w-full bg-card px-3 py-2 text-sm rounded outline-none focus:bg-card-strong mb-2"
        />
        <div className="flex flex-wrap gap-1">
          {Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => {
              const active = activeTypes.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={
                    'px-2 py-0.5 rounded text-[10px] font-mono transition-colors ' +
                    (active
                      ? 'bg-accent/30 text-ink'
                      : 'bg-card text-ink-muted hover:bg-card-strong hover:text-ink')
                  }
                >
                  {type} <span className="text-ink-faint">{count}</span>
                </button>
              );
            })}
          {activeTypes.size > 0 && (
            <button
              onClick={() => setActiveTypes(new Set())}
              className="px-2 py-0.5 rounded text-[10px] text-ink-faint hover:text-ink"
            >
              clear
            </button>
          )}
        </div>
      </div>
      <div className="overflow-y-auto px-5 py-2 flex-1 font-mono text-[11px]">
        {filtered.length === 0 ? (
          <div className="text-ink-faint py-3">
            {events.length === 0 ? 'No events yet.' : 'No events match your filter.'}
          </div>
        ) : (
          filtered.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              expanded={isExpanded(e.id)}
              onToggle={() => toggleExpanded(e.id)}
              query={query.trim()}
            />
          ))
        )}
      </div>
      </>
      )}
    </div>
  );
}

function DiagnosticsTab() {
  const [entries, setEntries] = useState<SilentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const next = await window.overcli.invoke('diagnostics:list');
    setEntries(next);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    await window.overcli.invoke('diagnostics:clear');
    await refresh();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-card flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">Silent failures</div>
          <div className="text-xs text-ink-faint">
            Errors caught and swallowed during this session. Persistent log at <code>~/.overcli/session.log</code>.
            {' '}
            {entries.length > 0 && `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`}
          </div>
        </div>
        <div className="flex gap-2 text-[11px]">
          <button
            onClick={refresh}
            className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
          >
            refresh
          </button>
          <button
            onClick={clear}
            disabled={entries.length === 0}
            className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
          >
            clear
          </button>
        </div>
      </div>
      <div className="overflow-y-auto px-5 py-2 flex-1 font-mono text-[11px]">
        {loading ? (
          <div className="text-ink-faint py-3">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-ink-faint py-3">No silent failures recorded this session.</div>
        ) : (
          entries
            .slice()
            .reverse()
            .map((e, i) => (
              <div key={i} className="border-b border-card last:border-b-0 py-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-ink-faint shrink-0">
                    {new Date(e.timestamp).toISOString().slice(11, 23)}
                  </span>
                  <span className="text-accent font-medium">{e.scope}</span>
                  <span className="text-ink-muted truncate">{e.message}</span>
                </div>
                {e.stack && (
                  <pre className="text-ink-faint whitespace-pre-wrap break-all pl-5 pt-0.5">
                    {e.stack}
                  </pre>
                )}
              </div>
            ))
        )}
      </div>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
  query,
}: {
  event: StreamEvent;
  expanded: boolean;
  onToggle: () => void;
  query: string;
}) {
  const [copied, setCopied] = useState(false);
  const time = new Date(event.timestamp).toISOString().slice(11, 23);
  const preview = getPreview(event);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(event.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="border-b border-card last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2 py-1 text-left hover:bg-card/50 -mx-2 px-2 rounded"
      >
        <span className="text-ink-faint shrink-0 select-none">{expanded ? '▾' : '▸'}</span>
        <span className="text-ink-faint shrink-0">{time}</span>
        <span className="shrink-0 text-accent font-medium">{event.kind.type}</span>
        {!expanded && (
          <span className="text-ink-muted truncate flex-1">{highlight(preview, query)}</span>
        )}
      </button>
      {expanded && (
        <div className="relative pb-2 pl-5">
          <button
            onClick={copy}
            className="absolute top-0 right-0 text-[10px] px-2 py-0.5 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <pre className="text-ink-muted whitespace-pre-wrap break-all select-text pr-14">
            {highlight(event.raw, query)}
          </pre>
        </div>
      )}
    </div>
  );
}

function getPreview(e: StreamEvent): string {
  const k = e.kind;
  if (k.type === 'localUser') return k.text.slice(0, 200);
  if (k.type === 'assistant') return (k.info.text ?? '').slice(0, 200);
  if (k.type === 'systemNotice') return k.text.slice(0, 200);
  if (k.type === 'metaReminder') return k.text.slice(0, 200);
  if (k.type === 'stderr') return k.line.slice(0, 200);
  if (k.type === 'parseError') return k.message.slice(0, 200);
  if (k.type === 'other') return k.label;
  const oneLine = e.raw.replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 200);
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-accent/40 text-ink rounded px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
  }
  return <>{parts}</>;
}
