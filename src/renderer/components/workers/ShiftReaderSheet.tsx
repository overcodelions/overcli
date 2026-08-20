// The shift reader: one turn, at full size, with a find box and somewhere to
// leave a note.
//
// A planning turn is the longest single piece of prose this app produces —
// the worker states what it read, what it ruled out and why, and on a busy
// project that is a thousand words. On the desk it lives in a bubble sized
// for a chat message: full window width, 12px type, a 56-line clamp with its
// own scrollbar, wrapped around a transcript that is scrolling underneath it.
// It is a document being shown in a message slot, and reading it that way is
// the complaint this exists to answer.
//
// What this deliberately is NOT is an editor. A turn is a record of what a
// worker did, and find-and-REPLACE over it would let you rewrite that record
// — the same text the worker's own journal and the run behind it are keyed
// to. So: find, which is what you actually need in a wall of text, and a
// note, which is how you say "this was wrong" without falsifying the page
// that was wrong.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Markdown } from '../Markdown';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { stripWorkerSubject, WORKER_NOTE_MAX } from '@shared/flows/worker';
import {
  describeActivity,
  relativeTime,
  toWorkerActivity,
} from './workerDeskSelectors';
import { matchOffsets, stepMatch } from './shiftFind';

/// Registered highlight names. Two, because "all the matches" and "the one
/// you are standing on" are different colours in every find box ever made,
/// and a reader stepping through 17 hits needs to see which one just moved.
const HL_ALL = 'shift-find';
const HL_CURRENT = 'shift-find-current';

export function ShiftReaderSheet({
  workerId,
  orchestrationId,
}: {
  workerId: string;
  orchestrationId: string;
}) {
  const close = useStore((s) => s.openSheet);
  const worker = useWorkersStore((s) => s.workers[workerId]);
  const orchestration = useOrchestratorStore(
    (s) => s.orchestrations[orchestrationId],
  );
  const journal = useWorkersStore((s) => s.journals[workerId]);
  const loadJournal = useWorkersStore((s) => s.loadJournal);
  const addNote = useWorkersStore((s) => s.addNote);

  // The journal is loaded on demand elsewhere (the Journal tab), so a reader
  // opened straight from the desk would show no notes at all until you had
  // been to that tab this session.
  useEffect(() => {
    if (!journal) void loadJournal(workerId);
  }, [journal, loadJournal, workerId]);

  const activity = useMemo(
    () => (orchestration ? toWorkerActivity(orchestration) : null),
    [orchestration],
  );
  const prose = useMemo(
    () =>
      stripWorkerSubject(orchestration?.producer?.reply ?? '')
        .replace(/<candidates>[\s\S]*$/i, '')
        .trim(),
    [orchestration],
  );

  const notes = useMemo(
    () =>
      (journal ?? [])
        .filter((e) => e.kind === 'note' && e.orchestrationId === orchestrationId)
        .sort((a, b) => a.at - b.at),
    [journal, orchestrationId],
  );

  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  // A new search starts at its first hit rather than wherever the last one
  // left you — the alternative is typing three letters and being told you are
  // on match 9 of 4.
  useEffect(() => setCurrent(0), [query]);

  // Debounced so a fast typist doesn't re-walk the whole transcript on every
  // keystroke — only once they pause.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    if (query.length < 2) { setDebouncedQuery(''); return; }
    const t = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(t);
  }, [query]);

  // Layout effect, not effect: highlights are painted, and computing them
  // after the browser has already shown the frame flashes the un-highlighted
  // text on every keystroke.
  useLayoutEffect(() => {
    const root = body.current;
    const store = highlightStore();
    if (!root || !store) return;
    const ranges = findRanges(root, debouncedQuery);
    setTotal(ranges.length);
    if (ranges.length === 0) {
      store.delete(HL_ALL);
      store.delete(HL_CURRENT);
      return;
    }
    const at = Math.min(current, ranges.length - 1);
    store.set(HL_ALL, new Highlight(...ranges));
    store.set(HL_CURRENT, new Highlight(ranges[at]));
    // Scroll through the element the match sits in: a Range has no
    // scrollIntoView of its own, and its parent element is close enough that
    // the hit lands in view.
    const host = ranges[at].startContainer.parentElement;
    if (host && !inView(host, root)) host.scrollIntoView({ block: 'center' });
    return () => {
      store.delete(HL_ALL);
      store.delete(HL_CURRENT);
    };
    // `prose` and `notes.length` are here because the ranges are DOM ranges:
    // they go stale the moment the rendered content changes under them.
  }, [debouncedQuery, current, prose, notes.length]);

  // ⌘F is the muscle memory for "find in this thing I am reading", and the
  // app's own ⌘F belongs to the file finder — which is not what someone
  // standing in front of a wall of prose is reaching for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        findInput.current?.select();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!worker || !orchestration || !activity) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-sm text-ink-muted">
        That turn is no longer here.
      </div>
    );
  }

  const step = (delta: number) => setCurrent((c) => stepMatch(c, total, delta));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-card-strong px-5 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">
            {activity.title}
            <span className="ml-2 text-[11px] font-normal text-ink-faint">
              {worker.name} · {describeActivity(activity)} ·{' '}
              {relativeTime(activity.at)}
            </span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <FindBox
            inputRef={findInput}
            query={query}
            onQuery={setQuery}
            current={current}
            total={total}
            onStep={step}
            available={!!highlightStore()}
          />
          <button
            onClick={() => void navigator.clipboard.writeText(prose)}
            title="Copy this turn's text"
            className="rounded border border-card-strong px-2 py-1 text-[11px] text-ink-muted hover:bg-white/5 hover:text-ink focus:outline-none"
          >
            Copy
          </button>
          <button
            onClick={() => close(null)}
            className="rounded px-2 py-1 text-[11px] text-ink-faint hover:text-ink focus:outline-none"
          >
            Close
          </button>
        </div>
      </div>

      {/* The reading column. Capped at a measure rather than run to the full
          1240px frame: line length is most of why the bubble was unreadable,
          and a wider modal that keeps 200-character lines fixes nothing. */}
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[78ch]">
          {activity.ask && (
            <div className="mb-5 rounded-lg border border-card-strong bg-card-strong/30 px-4 py-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">
                {activity.from ? `Handed over by ${activity.from}` : 'You asked'}
              </div>
              <div className="whitespace-pre-wrap text-[13px] text-ink-muted">
                {activity.ask}
              </div>
            </div>
          )}
          {prose ? (
            <div className="shift-reader-prose text-ink">
              <Markdown source={prose} />
            </div>
          ) : (
            <div className="text-sm text-ink-faint">
              The planning turn left no notes.
            </div>
          )}

          {orchestration.items.length > 0 && (
            <div className="mt-8 border-t border-card-strong pt-4">
              <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-faint">
                What it proposed
              </div>
              <ul className="space-y-1">
                {orchestration.items.map((it) => (
                  <li
                    key={it.candidate.id}
                    className="flex items-baseline gap-2 text-[13px] text-ink-muted"
                  >
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {it.status}
                    </span>
                    <span>{it.candidate.title}</span>
                  </li>
                ))}
              </ul>
              {/* The controls stay on the desk. This is the reading copy, and
                  a second set of Approve/Reject buttons in a modal is a second
                  place for the same decision to be half-made. */}
            </div>
          )}

          <Notes
            notes={notes.map((n) => ({ at: n.at, note: n.note ?? '' }))}
            onSave={(text) => addNote(workerId, orchestrationId, text)}
          />
        </div>
      </div>
    </div>
  );
}

/// Find, with the count. No replace — see the note at the top of this file.
function FindBox({
  inputRef,
  query,
  onQuery,
  current,
  total,
  onStep,
  available,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  query: string;
  onQuery: (q: string) => void;
  current: number;
  total: number;
  onStep: (delta: number) => void;
  /// False on an engine without the CSS custom-highlight API. Rather than
  /// silently searching and highlighting nothing, the box says so.
  available: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded border border-card-strong px-1.5 py-0.5">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onStep(e.shiftKey ? -1 : 1);
        }}
        placeholder={available ? 'Find…' : 'Find unavailable'}
        disabled={!available}
        className="w-36 bg-transparent text-[11px] text-ink placeholder:text-ink-faint focus:outline-none"
      />
      {query.trim() !== '' && (
        <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">
          {total === 0 ? 'none' : `${Math.min(current, total - 1) + 1}/${total}`}
        </span>
      )}
      <button
        onClick={() => onStep(-1)}
        disabled={total === 0}
        title="Previous match (⇧⏎)"
        className="px-1 text-[10px] leading-4 text-ink-faint hover:text-ink disabled:opacity-30 focus:outline-none"
      >
        ▲
      </button>
      <button
        onClick={() => onStep(1)}
        disabled={total === 0}
        title="Next match (⏎)"
        className="px-1 text-[10px] leading-4 text-ink-faint hover:text-ink disabled:opacity-30 focus:outline-none"
      >
        ▼
      </button>
    </div>
  );
}

/// Notes left against this turn.
///
/// These are journal entries, which is the whole point of them: the worker
/// reads its journal before planning every shift, so a note here is how you
/// correct a standing persona about THIS piece of work without editing the
/// job description, which is about the job.
function Notes({
  notes,
  onSave,
}: {
  notes: Array<{ at: number; note: string }>;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    if (await onSave(body)) setText('');
    setBusy(false);
  };

  return (
    <div className="mt-8 border-t border-card-strong pt-4">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-faint">
        Your notes
      </div>
      {notes.length > 0 && (
        <div className="mb-3 space-y-2">
          {notes.map((n) => (
            <div
              key={n.at}
              className="rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2"
            >
              <div className="mb-0.5 text-[10px] text-amber-500/80">
                {relativeTime(n.at)}
              </div>
              <div className="whitespace-pre-wrap text-[13px] text-ink-muted">
                {n.note}
              </div>
            </div>
          ))}
        </div>
      )}
      <textarea
        rows={3}
        value={text}
        maxLength={WORKER_NOTE_MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        placeholder="Tell the worker something about this turn — it reads this before planning its next shift."
        className="w-full rounded border border-card-strong bg-card p-3 text-[13px] text-ink placeholder:text-ink-faint"
      />
      <div className="mt-1.5 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy || !text.trim()}
          className="rounded bg-accent px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40 focus:outline-none"
        >
          {busy ? 'Saving…' : 'Add note'}
        </button>
        <span className="text-[10px] text-ink-faint">
          {WORKER_NOTE_MAX - text.length} characters left · ⌘⏎ to save
        </span>
      </div>
    </div>
  );
}

// ---- Highlighting --------------------------------------------------------

/// The CSS custom-highlight registry, or null where it doesn't exist.
/// Deliberately used rather than wrapping matches in `<mark>`: the prose is
/// React-rendered markdown, and mutating that DOM behind React's back is how
/// you get a find box that quietly eats the content it searched.
function highlightStore(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
}

/// Every match under `root`, as DOM Ranges. The text of every text node is
/// concatenated first, so a match is found across element boundaries — the
/// markdown renderer splits `**RED**-6787` into three nodes, and a reader
/// searching for `RED-6787` does not care.
function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    starts.push(text.length);
    nodes.push(node);
    text += node.nodeValue ?? '';
  }
  const locate = (offset: number): [Text, number] => {
    // The last node that starts at or before this offset.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };
  const out: Range[] = [];
  for (const [from, to] of matchOffsets(text, query)) {
    const [startNode, startOffset] = locate(from);
    const [endNode, endOffset] = locate(to - 1);
    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      // `to - 1` located the node holding the LAST character, so the end
      // offset is one past it within that node.
      range.setEnd(endNode, endOffset + 1);
      out.push(range);
    } catch {
      // A node that moved between the walk and now — skip that one match
      // rather than dropping the whole search.
    }
  }
  return out;
}

function inView(el: HTMLElement, scroller: HTMLElement): boolean {
  const a = el.getBoundingClientRect();
  const b = scroller.getBoundingClientRect();
  return a.top >= b.top && a.bottom <= b.bottom;
}
