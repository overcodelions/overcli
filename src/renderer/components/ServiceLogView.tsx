// A service's output, as close to the terminal it came from as a log view
// gets.
//
// Two things were wrong with printing the lines plainly. The escape sequences
// a dev server emits showed up as `[36m[vite][39m`, so the pane looked
// nothing like the terminal beside it; and a few thousand lines with no way to
// search them is a scrollback, not an answer to the question someone opened
// the log to ask.
//
// And a JVM service with colour off prints everything in one grey — level,
// date, thread, logger, message — so the lines are split into those parts and
// laid out in columns. `Raw` puts them back exactly as written.

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { collapseCarriageReturns, parseAnsi } from '../ansi';
import { countLevels, describeFilter, filterLog, highlightRuns, parsedLine, type LogLevel } from '../logFilter';
import { exceptionMessage, groupLog, isTraceHeader } from '../stackFrames';
import { listExceptions, type CaughtException, type ExceptionLog } from '@shared/exceptions';
import { summarizeLong, type Level, type ParsedLogLine } from '../logLine';
import { SelectionMenu } from './SelectionMenu';
import { useDividerDragging } from './ResizableDivider';

/// Past this, a line is folded: a classpath dump is one "line" of eight
/// thousand characters, and wrapped it pushes everything else off screen.
const LONG_LINE = 400;

/// Rows off screen skip layout and paint until scrolled to — thousands of lines
/// of output otherwise cost the same to lay out as the forty on screen. Only
/// while wrapping: unwrapped, the pane's width comes from its widest row, which
/// a skipped row cannot report.
const OFFSCREEN_ROW: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 17px' };

/// Wrapping is a preference about how someone reads logs, not about one
/// service, so it is remembered once for every log view.
const WRAP_KEY = 'overcli.serviceLog.wrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function LogView({
  lines: incoming,
  onClear,
  selection,
  file,
  exceptions,
}: {
  lines: readonly string[];
  /// The full output on disk, past what the pane holds. Absent, no Log file menu.
  file?: LogFileActions;
  /// Exceptions pulled out of the output, kept past the line cap.
  exceptions?: ExceptionLog;
  /// Empties the output. Absent, there is no Clear button.
  onClear?: () => void;
  /// What selected text can be handed to. Absent, selecting is just selecting.
  selection?: {
    onAsk: (text: string) => void;
    flows: readonly { id: string; name: string }[];
    onRunFlow: (flowId: string, text: string) => void;
  };
}) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<LogLevel>('all');
  const [pinned, setPinned] = useState(true);
  const [formatted, setFormatted] = useState(true);
  const [hidden, setHidden] = useState<ReadonlySet<Level>>(new Set());
  const [wrap, setWrap] = useState(readWrap);
  const [showExceptions, setShowExceptions] = useState(false);
  // Hold the output still while a divider is being dragged. A live service
  // pushes a batch of lines several times a second, and re-filtering,
  // regrouping and re-rendering ten thousand rows between two pointer moves is
  // what makes resizing a busy log pane crawl. Nothing is lost: the next
  // render after release has every line.
  const dragging = useDividerDragging();
  const held = useRef(incoming);
  if (!dragging) held.current = incoming;
  const lines = held.current;
  const caught = useMemo(() => (exceptions ? listExceptions(exceptions) : []), [exceptions]);
  const scroller = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => filterLog(lines, { query, level, hidden }),
    [lines, query, level, hidden],
  );
  const levelCounts = useMemo(() => countLevels(lines), [lines]);
  // Forty lines of `at org.springframework…` around one sentence is a needle in
  // its own haystack. Folded by default; never while searching, since the
  // match may well be inside a frame.
  const items = useMemo(() => groupLog(shown, { collapse: query.trim() === '' }), [shown, query]);
  const byIndex = useMemo(() => new Map(shown.map((l) => [l.index, l])), [shown]);
  const summary = describeFilter(lines.length, shown.length);
  const problems = useMemo(() => filterLog(lines, { level: 'problems' }).length, [lines]);

  // The rows themselves, memoised: this component re-renders whenever anything
  // around it does, and handing React the same element array lets it skip
  // reconciling ten thousand children for a render that changed a toolbar
  // count.
  const rows = useMemo(
    () =>
      items.map((item, i) =>
        item.kind === 'frames' ? (
          <div
            key={`frames-${item.indices[0]}-${i}`}
            data-line={item.indices[0]}
            data-line-end={item.indices[item.indices.length - 1]}
            style={wrap ? OFFSCREEN_ROW : undefined}
          >
            <Frames indices={item.indices} byIndex={byIndex} raw={lines} />
          </div>
        ) : (
          <div key={item.index} data-line={item.index} style={wrap ? OFFSCREEN_ROW : undefined}>
            <Line
              text={byIndex.get(item.index)?.text ?? ''}
              matches={byIndex.get(item.index)?.matches ?? []}
              raw={lines[item.index]}
              formatted={formatted}
            />
          </div>
        ),
      ),
    [items, byIndex, lines, wrap, formatted],
  );

  // Follow the output, but stop the moment someone scrolls up: nothing is
  // more annoying than reading a stack trace that keeps yanking itself away.
  useEffect(() => {
    if (!pinned) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown, pinned]);

  return (
    <>
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-card px-4 py-1.5">
        <input
          className="field w-[200px] px-2 py-1 text-[11px]"
          placeholder="Search output"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={level === 'problems' ? 'svc-btn-primary' : 'svc-btn'}
          onClick={() => setLevel((l) => (l === 'problems' ? 'all' : 'problems'))}
          title="Only lines that look like a failure"
        >
          Problems{problems > 0 && <span className="text-ink-faint">{problems}</span>}
        </button>
        {/* One toggle per level that actually occurs, each with its count —
            DEBUG off is the usual first move on a Spring log, and the count
            says how much that hides before anyone commits to it. */}
        {LEVEL_ORDER.filter((l) => levelCounts[l] > 0).map((l) => {
          const on = !hidden.has(l);
          return (
            <button
              key={l}
              className={`inline-flex h-[22px] items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10px] leading-none ${
                on
                  ? `border-card-strong ${LEVEL_TONE[l].badge}`
                  : 'border-card text-ink-faint line-through opacity-60'
              }`}
              onClick={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(l)) next.delete(l);
                  else next.add(l);
                  return next;
                })
              }
              title={on ? `Hide ${LEVEL_LABEL[l]} lines` : `Show ${LEVEL_LABEL[l]} lines`}
            >
              {LEVEL_LABEL[l]}
              <span className="text-ink-faint">{levelCounts[l].toLocaleString()}</span>
            </button>
          );
        })}
        {summary && <span className="text-[10px] text-ink-faint">{summary}</span>}
        <div className="flex-1" />
        {!pinned && (
          <button className="svc-btn" onClick={() => setPinned(true)}>
            Follow
          </button>
        )}
        <button
          className={wrap ? 'svc-btn-primary' : 'svc-btn'}
          onClick={() =>
            setWrap((w) => {
              try {
                localStorage.setItem(WRAP_KEY, String(!w));
              } catch {
                // Not remembered, still toggled.
              }
              return !w;
            })
          }
          title={wrap ? 'Keep each line on one row and scroll sideways' : 'Wrap long lines to the pane'}
        >
          Wrap
        </button>
        <button
          className={formatted ? 'svc-btn' : 'svc-btn-primary'}
          onClick={() => setFormatted((f) => !f)}
          title="Show the output exactly as the process wrote it"
        >
          Raw
        </button>
        {caught.length > 0 && (
          <button
            className={showExceptions ? 'svc-btn-primary' : 'svc-btn'}
            onClick={() => setShowExceptions((v) => !v)}
            title="Each distinct exception once, with a count — kept after its lines scroll out"
          >
            Exceptions
            <span className="rounded-full bg-red-500/15 px-1.5 font-semibold text-red-600 dark:text-red-300">
              {caught.length}
            </span>
          </button>
        )}
        {file && <LogFileMenu file={file} />}
        {onClear && (
          <button
            className="svc-btn"
            onClick={() => {
              onClear();
              setPinned(true);
            }}
            disabled={lines.length === 0}
            title="Clear this output — new lines keep arriving"
          >
            Clear
          </button>
        )}
        <span className="text-[10px] text-ink-faint">{lines.length.toLocaleString()} lines</span>
      </div>
      {showExceptions && caught.length > 0 && <ExceptionsPanel items={caught} onAsk={selection?.onAsk} />}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          // A few pixels of slack: "at the bottom" should survive a fractional
          // scroll height, which is how a zoomed display reports one.
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className={`min-h-0 flex-1 px-4 py-2.5 font-mono text-[11px] leading-[17px] text-ink-muted ${
          wrap ? 'overflow-y-auto' : 'overflow-auto'
        }`}
      >
        {/* Unwrapped, every row is as wide as its longest line and the pane
            scrolls sideways; the per-part wrapping classes below are
            overridden here rather than threaded through each component. */}
        <div className={wrap ? '' : 'w-max min-w-full whitespace-pre [&_*]:!whitespace-pre [&_*]:!break-normal'}>
          {lines.length === 0 ? (
            <span className="text-ink-faint">Nothing yet — press Start.</span>
          ) : shown.length === 0 ? (
            <span className="text-ink-faint">
              No line matches. {lines.length.toLocaleString()} are hidden.
            </span>
          ) : (
            rows
          )}
        </div>
      </div>
      {selection && (
        <SelectionMenu
          container={scroller}
          readText={(range, fallback) => {
            const lineOf = (node: Node) =>
              (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-line]') ?? null;
            const first = lineOf(range.startContainer);
            const last = lineOf(range.endContainer);
            // Words inside one line are the words wanted. Across lines, the
            // lines as written: the columns read back from the DOM run
            // together, and a folded trace stands for all of its frames.
            if (!first || !last || (first === last && first.dataset.lineEnd === undefined)) return fallback;
            const from = Number(first.dataset.line);
            const to = Number(last.dataset.lineEnd ?? last.dataset.line);
            return shown
              .filter((l) => l.index >= from && l.index <= to)
              .map((l) => l.text)
              .join('\n');
          }}
          // Following the output would scroll the selection away under the
          // bar that is offering to do something with it.
          onOpen={() => setPinned(false)}
          onAsk={selection.onAsk}
          flows={selection.flows}
          onRunFlow={selection.onRunFlow}
        />
      )}
    </>
  );
}

/// A run of stack frames, folded. Opens in place; nothing was discarded.
function Frames({
  indices,
  byIndex,
  raw,
}: {
  indices: number[];
  byIndex: Map<number, { text: string; matches: readonly [number, number][] }>;
  raw: readonly string[];
}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <>
        <button
          className="my-0.5 block text-[10.5px] text-ink-faint hover:text-ink"
          onClick={() => setOpen(false)}
        >
          ▾ hide {indices.length} frames
        </button>
        {indices.map((index) => (
          <div key={index} className="pl-3 text-ink-faint">
            {byIndex.get(index)?.text ?? raw[index]}
          </div>
        ))}
      </>
    );
  }

  // The first frame is the one that names the code, so it earns its place on
  // the folded row — the rest is the framework getting there.
  const first = (byIndex.get(indices[0])?.text ?? raw[indices[0]] ?? '').trim();
  return (
    <button
      className="my-0.5 flex w-full items-baseline gap-2 text-left text-ink-faint hover:text-ink-muted"
      onClick={() => setOpen(true)}
      title="Show the whole trace"
    >
      <span className="text-[10.5px]">▸ {indices.length} frames</span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] opacity-70">{first}</span>
    </button>
  );
}

/// Memoised: a batch of new lines re-renders the list, and every row already
/// on it is unchanged.
const Line = memo(function Line({
  text,
  matches,
  raw,
  formatted,
}: {
  text: string;
  matches: readonly [number, number][];
  raw: string;
  formatted: boolean;
}) {
  // The engine's own markers are ours, not the process's — a rebind divider
  // reads as a break in the stream rather than a line of output.
  if (text.startsWith('──')) {
    return <div className="my-2 text-accent">{text}</div>;
  }

  // While searching, the highlight matters more than the colour: a matched run
  // has to be findable at a glance, and the two decorations fight.
  if (matches.length > 0) {
    return (
      <div>
        {highlightRuns(text, matches).map((run, i) =>
          run.match ? (
            <mark key={i} className="rounded-[2px] bg-amber-400/40 text-ink">
              {run.text}
            </mark>
          ) : (
            <span key={i}>{run.text}</span>
          ),
        )}
      </div>
    );
  }

  // The actual cause, which is what everyone scrolls to find.
  if (isTraceHeader(text)) {
    return <div className="mt-1 text-red-700 dark:text-red-300">{text}</div>;
  }

  // A line that carries its own colour is already formatted by the process
  // that wrote it; only a plain line is laid out here.
  if (formatted && raw === text) {
    const parsed = parsedLine(text);
    if (parsed) return <Structured line={parsed} />;
    if (text.length > LONG_LINE) return <Fold text={text} />;
  }

  return (
    <div>
      {parseAnsi(collapseCarriageReturns(raw)).map((segment, i) => (
        <span
          key={i}
          style={{
            color: segment.color,
            fontWeight: segment.bold ? 600 : undefined,
            opacity: segment.dim ? 0.65 : undefined,
          }}
        >
          {segment.text}
        </span>
      ))}
      {text === '' && ' '}
    </div>
  );
});

const LEVEL_ORDER: readonly Level[] = ['error', 'warn', 'info', 'debug', 'trace'];

const LEVEL_LABEL: Record<Level, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
  trace: 'TRACE',
};

/// Level in colour, because it is the one word on the line worth finding
/// without reading. Everything else on the left is context, and dimmed.
const LEVEL_TONE: Record<Level, { badge: string; message: string }> = {
  error: { badge: 'text-red-600 dark:text-red-400', message: 'text-red-700 dark:text-red-300' },
  warn: { badge: 'text-amber-600 dark:text-amber-400', message: 'text-ink' },
  info: { badge: 'text-sky-600 dark:text-sky-400', message: 'text-ink' },
  debug: { badge: 'text-ink-faint', message: 'text-ink-muted' },
  trace: { badge: 'text-ink-faint', message: 'text-ink-faint' },
};

/// One recognised line, in columns that line up down the page — so the eye can
/// run down the levels, or down the messages, without re-finding its place.
function Structured({ line }: { line: ParsedLogLine }) {
  const tone = LEVEL_TONE[line.level];
  const quiet = line.level === 'debug' || line.level === 'trace';
  return (
    <div className={`flex gap-2 ${quiet ? 'opacity-70' : ''}`}>
      <span className={`w-[38px] flex-shrink-0 font-semibold ${tone.badge}`}>
        {LEVEL_LABEL[line.level]}
      </span>
      {line.time && (
        <span className="w-[84px] flex-shrink-0 text-ink-faint" title={line.stamp}>
          {line.time}
        </span>
      )}
      {line.logger && (
        <span
          className="w-[190px] flex-shrink-0 truncate text-ink-faint"
          title={[line.loggerFull, line.thread && `thread ${line.thread}`].filter(Boolean).join(' · ')}
        >
          {line.logger}
        </span>
      )}
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${tone.message}`}>
        {line.message.length > LONG_LINE ? <Fold text={line.message} /> : line.message}
        {line.fields && <Fields fields={line.fields} />}
        {line.stack && <Stack text={line.stack} />}
      </span>
    </div>
  );
}

/// A JSON record's other fields — a trace id, a request path. Dim, after the
/// message, because they are what someone searches for rather than reads.
function Fields({ fields }: { fields: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(fields);
  const SHOWN = 4;
  const visible = open ? entries : entries.slice(0, SHOWN);
  return (
    <span className="ml-2 text-[10.5px] text-ink-faint">
      {visible.map(([key, value]) => (
        <span key={key} className="mr-2 break-all" title={`${key}=${value}`}>
          <span className="opacity-70">{key}=</span>
          {value.length > 80 && !open ? `${value.slice(0, 80)}…` : value}
        </span>
      ))}
      {entries.length > SHOWN && (
        <button className="hover:text-ink" onClick={() => setOpen((o) => !o)}>
          {open ? 'fewer' : `+${entries.length - SHOWN}`}
        </button>
      )}
    </span>
  );
}

/// A stack trace that arrived inside a JSON field rather than on the lines
/// after it. Folded like the frames of a text log: the first line — the
/// exception — shows, the rest opens on request.
function Stack({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = text.split('\n');
  return (
    <span className="mt-0.5 block text-red-700 dark:text-red-300">
      {first}
      {rest.length > 0 && (
        <button
          className="ml-1.5 text-[10.5px] text-ink-faint hover:text-ink"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾ hide frames' : `▸ ${rest.length} frames`}
        </button>
      )}
      {open && <span className="block pl-3 text-ink-faint">{rest.join('\n')}</span>}
    </span>
  );
}

/// A very long line, cut to what reads and opened on request. Nothing is
/// dropped — it is all still there, and still searchable.
function Fold({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { head, hidden } = summarizeLong(text, LONG_LINE);
  return (
    <span className="block break-all">
      {open ? text : head}
      <button
        className="ml-1.5 text-[10.5px] text-ink-faint hover:text-ink"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'show less' : `… ${hidden.toLocaleString()} more characters`}
      </button>
    </span>
  );
}

export interface LogFileActions {
  reveal: () => void;
  path: () => Promise<string>;
  /// Start a conversation pointed at the file.
  onAsk?: (file: string) => void;
}

/// The whole log, not the pane's window onto it: reveal it, copy its path to
/// drop into a conversation already running, or start one about it.
function LogFileMenu({ file }: { file: LogFileActions }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const item = 'block w-full px-3 py-1.5 text-left text-[11px] hover:bg-card-strong';
  return (
    <div ref={menu} className="relative">
      <button
        className="svc-btn"
        onClick={() => setOpen((o) => !o)}
        title="Every line this service has printed, on disk"
      >
        {copied ? 'Copied' : 'Log file'}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[200px] rounded-md border border-card-strong bg-surface-elevated py-1 shadow-lg">
          <button
            className={item}
            onClick={async () => {
              setOpen(false);
              await navigator.clipboard.writeText(await file.path());
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }}
          >
            Copy path
          </button>
          <button
            className={item}
            onClick={() => {
              setOpen(false);
              file.reveal();
            }}
          >
            Reveal in Finder
          </button>
          {file.onAsk && (
            <button
              className={item}
              onClick={async () => {
                setOpen(false);
                file.onAsk?.(await file.path());
              }}
            >
              Ask an agent what went wrong
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/// One row per distinct exception, however many times it was thrown and
/// however long ago its lines left the buffer. The count leads the row: an
/// exception thrown fifteen times is a different problem from one thrown once.
function ExceptionsPanel({
  items,
  onAsk,
}: {
  items: readonly CaughtException[];
  onAsk?: (text: string) => void;
}) {
  const [order, setOrder] = useState<'recent' | 'frequent'>('recent');
  const [openSignature, setOpenSignature] = useState<string | null>(null);
  const sorted = useMemo(
    () => (order === 'recent' ? items : [...items].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)),
    [items, order],
  );
  const thrown = items.reduce((sum, item) => sum + item.count, 0);
  const open = items.find((item) => item.signature === openSignature);

  return (
    <div className="flex max-h-[40%] flex-shrink-0 flex-col border-b border-card bg-surface-muted text-[11px]">
      <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-1 pt-1.5 text-[10.5px] text-ink-faint">
        <span>
          {items.length} distinct · {thrown.toLocaleString()} thrown
        </span>
        <div className="flex-1" />
        <button
          className={order === 'recent' ? 'svc-btn-primary' : 'svc-btn'}
          onClick={() => setOrder('recent')}
        >
          Newest
        </button>
        <button
          className={order === 'frequent' ? 'svc-btn-primary' : 'svc-btn'}
          onClick={() => setOrder('frequent')}
        >
          Most frequent
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-4 pb-1">
        {sorted.map((item) => {
          const parsed = exceptionMessage(item.header);
          const text = item.sample.join('\n');
          return (
            <div key={item.signature} className="flex items-center gap-2 border-t border-card py-1">
              <CountPill count={item.count} />
              <button
                className="min-w-0 flex-1 truncate text-left hover:underline"
                onClick={() => setOpenSignature(item.signature)}
                title="Open the trace"
              >
                <span className={`font-mono ${LEVEL_TONE.error.badge}`}>{parsed?.type ?? (item.header || 'Stack trace')}</span>
                {parsed?.message && <span className="text-ink-muted"> {parsed.message}</span>}
              </button>
              <span className="text-[10px] text-ink-faint">{new Date(item.lastAt).toLocaleTimeString()}</span>
              <button className="svc-btn" onClick={() => void navigator.clipboard.writeText(text)}>
                Copy
              </button>
              {onAsk && (
                <button className="svc-btn" onClick={() => onAsk(text)}>
                  Ask
                </button>
              )}
            </div>
          );
        })}
      </div>
      {open && <ExceptionModal item={open} onAsk={onAsk} onClose={() => setOpenSignature(null)} />}
    </div>
  );
}

function CountPill({ count, large = false }: { count: number; large?: boolean }) {
  const repeated = count > 1;
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full font-mono font-semibold tabular-nums ${
        large ? 'h-6 min-w-[44px] px-2 text-[12px]' : 'h-[18px] min-w-[38px] px-1.5 text-[10.5px]'
      } ${
        repeated
          ? 'bg-red-500/20 text-red-700 ring-1 ring-red-500/40 dark:text-red-300'
          : 'bg-card-strong text-ink-faint'
      }`}
      title={`Thrown ${count.toLocaleString()} time${count === 1 ? '' : 's'}`}
    >
      ×{count.toLocaleString()}
    </span>
  );
}

/// The whole trace, readable: the panel row is one truncated line, and a
/// Spring message is often the longest thing on the screen.
function ExceptionModal({
  item,
  onAsk,
  onClose,
}: {
  item: CaughtException;
  onAsk?: (text: string) => void;
  onClose: () => void;
}) {
  const parsed = exceptionMessage(item.header);
  const text = item.sample.join('\n');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[min(980px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-card px-4 py-3">
          <CountPill count={item.count} large />
          <div className="min-w-0 flex-1">
            <div className={`font-mono text-sm font-semibold ${LEVEL_TONE.error.badge}`}>
              {parsed?.type ?? (item.header || 'Stack trace')}
            </div>
            {parsed?.message && (
              <div className="mt-0.5 break-words text-xs text-ink">{parsed.message}</div>
            )}
            <div className="mt-1 text-[10.5px] text-ink-faint">
              Thrown {item.count.toLocaleString()} time{item.count === 1 ? '' : 's'}
              {' · '}first {new Date(item.firstAt).toLocaleTimeString()}
              {item.count > 1 && ` · last ${new Date(item.lastAt).toLocaleTimeString()}`}
            </div>
          </div>
          <button className="px-2 text-ink-muted hover:text-ink" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[11px] leading-[17px] text-ink-muted">
          {text}
        </pre>
        <div className="flex items-center gap-2 border-t border-card px-4 py-2.5">
          <span className="flex-1 text-[10.5px] text-ink-faint">
            As first seen — the line before the exception, the trace and its causes.
          </span>
          <button
            className="svc-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }}
          >
            {copied ? 'Copied' : 'Copy trace'}
          </button>
          {onAsk && (
            <button
              className="svc-btn-primary"
              onClick={() => {
                onClose();
                onAsk(text);
              }}
            >
              Ask an agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
