// Commenting on a team task's work: on a passage of a file, on the
// coordinator's questions or plan, or to one member in the flow. Each comment
// goes to main (`teams:comment`), which decides what it does from where the
// task is — re-plan, steer a running piece, ask the team, or brief what comes
// next — and the task comes back with it in `comments`.
//
// The box is one small popover, anchored to whatever opened it. Escape
// closes it and focus goes back to where it came from.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { TeamAssignment, TeamComment, TeamTask } from "@shared/flows/team";
import { useTeamsStore } from "../../../teamsStore";
import { useFlowsStore } from "../../../flowsStore";
import { useWorkersStore } from "../../../workersStore";
import { WorkerAvatar } from "../WorkerAvatar";
import { fileTime } from "./folderView";
import {
  canRedoPiece,
  commentHint,
  coordinatorHint,
  commentOutcomeText,
  commentTopicLabel,
  commentsOnFile,
  locateQuote,
  newestFirst,
  quoteFromSelection,
} from "./commentView";

const primaryBtn = "text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40";
const secondaryBtn =
  "text-xs px-3 py-1.5 rounded-md border border-card-strong text-ink hover:bg-card-strong disabled:opacity-40";
const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

/// What a comment box is about.
export type CommentTarget =
  | { kind: "file"; file: string; quote?: string }
  | { kind: "questions" }
  | { kind: "plan" }
  /// A note to the coordinator: "Wes redid his savings list, use the new one".
  | { kind: "coordinator" }
  /// One member, from their piece in a stage (or their lane, with no piece).
  | { kind: "member"; workerId: string; workerName: string; stageIndex?: number; piece?: TeamAssignment };

const POPOVER_W = 380;

/// The comment box, fixed beside `anchor`: under it, or over it when there
/// is no room below.
export function CommentPopover({
  task,
  target,
  anchor,
  onClose,
  onOpenFile,
  opener: openerEl,
  returnFocus,
}: {
  task: TeamTask;
  target: CommentTarget;
  anchor: DOMRect;
  onClose: () => void;
  onOpenFile?: (name: string) => void;
  /// The control that opened it and toggles it: a press there is not a
  /// click away.
  opener?: HTMLElement | null;
  /// Where focus goes when it closes; else the opener, else wherever it was
  /// when it opened.
  returnFocus?: HTMLElement | null;
}) {
  const comment = useTeamsStore((s) => s.comment);
  const redoPiece = useTeamsStore((s) => s.redoPiece);
  const worker = useWorkersStore((s) => (target.kind === "member" ? s.workers[target.workerId] : undefined));
  const [text, setText] = useState("");
  const [sending, setSending] = useState<"send" | "redo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const close = () => {
    onClose();
    const back = returnFocus ?? openerEl ?? (opener.current as HTMLElement | null);
    if (back?.isConnected) back.focus?.();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    opener.current = document.activeElement;
    const h = box.current?.offsetHeight ?? 220;
    const below = window.innerHeight - anchor.bottom >= h + 12 || anchor.top < h + 12;
    setPos({
      top: below ? Math.min(anchor.bottom + 6, window.innerHeight - h - 8) : anchor.top - h - 6,
      left: Math.min(Math.max(anchor.left, 8), window.innerWidth - POPOVER_W - 8),
    });
    field.current?.focus();
    // Placed once, where it opened: following the anchor as the page
    // scrolls would move the box out from under your typing.
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    // A stray click away closes an empty box, never one you've written in.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || openerEl?.contains(t)) return;
      if (!textRef.current.trim()) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose, openerEl]);

  const piece = target.kind === "member" ? target.piece : undefined;
  const redo = target.kind === "member" && target.stageIndex !== undefined && canRedoPiece(task, target.stageIndex, target.workerId);
  const hint =
    target.kind === "coordinator" ? coordinatorHint(task) : commentHint(task, target.kind === "member" ? { workerName: target.workerName, status: piece?.status, redo } : undefined);

  const send = async (how: "send" | "redo") => {
    if (sending) return;
    if (how === "send" && !text.trim()) return;
    setSending(how);
    setError(null);
    const res =
      how === "redo" && target.kind === "member"
        ? await redoPiece(task.id, target.workerId, text.trim() || undefined)
        : await comment(task.id, {
            text: text.trim(),
            ...(target.kind === "file" ? { file: target.file, ...(target.quote ? { quote: target.quote } : {}) } : {}),
            ...(target.kind === "questions" || target.kind === "plan" || target.kind === "coordinator" ? { about: target.kind } : {}),
            ...(target.kind === "member" ? { workerId: target.workerId } : {}),
          });
    setSending(null);
    if (res.ok) close();
    else setError(res.error);
  };

  const title =
    target.kind === "file"
      ? target.quote
        ? "Comment on this passage"
        : `Comment on ${target.file.split("/").pop()}`
      : target.kind === "questions"
        ? "Comment on the questions"
        : target.kind === "plan"
          ? "Comment on the plan"
          : target.kind === "coordinator"
            ? "Say something to the coordinator"
            : `Say something to ${target.workerName}`;
  const stageTitle = target.kind === "member" && target.stageIndex !== undefined ? task.stages[target.stageIndex]?.title : undefined;

  const viewRun = piece?.runId
    ? () => {
        useWorkersStore.getState().selectWorker(piece.workerId);
        useFlowsStore.getState().setActiveRun(piece.runId!);
        onClose();
      }
    : undefined;

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: POPOVER_W }}
      className="z-50 flex flex-col gap-3 rounded-xl border border-card bg-surface-elevated p-4 text-xs shadow-2xl"
    >
      <div className="flex items-start gap-2.5">
        {worker ? (
          <WorkerAvatar worker={worker} size="sm" live={piece?.status === "running"} />
        ) : target.kind === "coordinator" ? (
          <span aria-hidden className="mt-0.5 h-6 w-6 shrink-0 rounded-md bg-card-strong" />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-ink">{title}</span>
          {piece && (
            <span className="truncate text-[11px] text-ink-faint">
              {stageTitle ? `${stageTitle} · ` : ""}
              <span className={piece.status === "running" ? "text-accent" : piece.status === "done" ? "text-emerald-700 dark:text-emerald-400" : ""}>{pieceState(piece)}</span>
            </span>
          )}
        </span>
        <button className="rounded-md px-1.5 text-base leading-none text-ink-faint hover:bg-card-strong hover:text-ink" aria-label="Close" onClick={close}>
          ×
        </button>
      </div>
      {piece && (
        <div className="flex flex-col gap-2 rounded-lg bg-surface px-3 py-2.5">
          <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-muted" title={piece.ask}>
            {piece.ask}
          </p>
          {(piece.file && onOpenFile) || viewRun ? (
            <div className="flex items-center gap-3">
              {piece.file && onOpenFile && (
                <button
                  className="text-[11.5px] font-medium text-accent hover:underline"
                  onClick={() => {
                    onClose();
                    onOpenFile(piece.file!);
                  }}
                >
                  Read the piece
                </button>
              )}
              {viewRun && (
                <button className="text-[11.5px] font-medium text-accent hover:underline" onClick={viewRun}>
                  View the run
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
      {target.kind === "file" && target.quote && (
        <blockquote className="line-clamp-4 whitespace-pre-wrap border-l-2 border-amber-400/60 pl-2 text-[11.5px] italic leading-relaxed text-ink-muted">
          {target.quote}
        </blockquote>
      )}
      <textarea
        ref={field}
        rows={3}
        value={text}
        aria-label={title}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send("send");
          }
        }}
        placeholder={
          target.kind === "member"
            ? `Say something to ${target.workerName}`
            : target.kind === "coordinator"
              ? "e.g. Wes redid his savings list: use the new totals in the inventory."
              : "What should change, or what should the team know?"
        }
        className="field resize-y px-3 py-2 text-[13px] leading-relaxed"
      />
      <p className="text-[11px] leading-snug text-ink-faint">{hint}</p>
      {error && (
        <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[10.5px] text-ink-faint">⌘⏎ to send</span>
        {redo && (
          <button
            className={secondaryBtn}
            disabled={!!sending}
            title={piece?.status === "running" ? "Stop this piece and start it again with what you wrote" : "Do this piece again with what you wrote, replacing it"}
            onClick={() => void send("redo")}
          >
            {sending === "redo" ? "Starting…" : text.trim() ? "Redo with this" : "Redo"}
          </button>
        )}
        <button className={primaryBtn} disabled={!!sending || !text.trim()} onClick={() => void send("send")}>
          {sending === "send" ? "Sending…" : "Send"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function pieceState(a: TeamAssignment): string {
  switch (a.status) {
    case "done":
      return "Done";
    case "running":
      return "Working…";
    case "paused":
      return "Waiting on you";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return "Up next";
  }
}

/// A quiet "Comment" that opens the box under itself.
export function CommentButton({
  task,
  target,
  label = "Comment",
  className,
  onOpenFile,
}: {
  task: TeamTask;
  target: CommentTarget;
  label?: string;
  className?: string;
  onOpenFile?: (name: string) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        ref={btn}
        className={(className ?? quietBtn) + " inline-flex items-center gap-1"}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => setAnchor((a) => (a ? null : btn.current!.getBoundingClientRect()))}
      >
        <CommentGlyph /> {label}
      </button>
      {anchor && (
        <CommentPopover
          task={task}
          target={target}
          anchor={anchor}
          opener={btn.current}
          onOpenFile={onOpenFile}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

export function CommentGlyph() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="shrink-0">
      <path d="M2 2.5h8v5.5H6l-2.5 2V8H2z" />
    </svg>
  );
}

/// One comment, as it reads in a list: what it's about, the passage, what
/// you said, and what came of it.
function CommentItem({ c, showTopic }: { c: TeamComment; showTopic: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {showTopic && <span className="truncate text-[10.5px] text-ink-faint">{commentTopicLabel(c)}</span>}
      {c.quote && (
        <span className="line-clamp-2 whitespace-pre-wrap border-l-2 border-amber-400/60 pl-2 text-[11px] italic leading-snug text-ink-muted">
          {c.quote}
        </span>
      )}
      <span className="line-clamp-4 whitespace-pre-wrap text-xs leading-snug text-ink">{c.text}</span>
      <span className="text-[10.5px] text-ink-faint">
        {fileTime(c.at)} · <span className={c.outcome === "queued" || !c.outcome ? "" : "text-ink-muted"}>{commentOutcomeText(c)}</span>
      </span>
    </span>
  );
}

const SHOWN = 5;

/// Every comment on the task, newest first, for the side column. One on a
/// passage opens its file there.
export function CommentsPanel({ task, onOpenComment }: { task: TeamTask; onOpenComment: (c: TeamComment) => void }) {
  const list = newestFirst(task.comments);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  if (list.length === 0) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <section aria-label="Comments" className="flex flex-col gap-2">
      <button
        className="flex items-center gap-1.5 text-left text-xs font-semibold text-ink"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className={"text-ink-faint transition-transform " + (open ? "rotate-90" : "")}>
          <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Comments <span className="font-normal text-ink-faint">· {list.length}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {shown.map((c) => (
            <li key={c.id}>
              {c.file ? (
                <button
                  className="flex w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:bg-card-strong"
                  title={c.quote ? "Open the file at this passage" : "Open the file"}
                  onClick={() => onOpenComment(c)}
                >
                  <CommentItem c={c} showTopic />
                </button>
              ) : (
                <div className="px-2 py-1.5">
                  <CommentItem c={c} showTopic />
                </div>
              )}
            </li>
          ))}
          {list.length > SHOWN && (
            <li>
              <button className={quietBtn} onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${list.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// ---- In a file -------------------------------------------------------------

const HL_COMMENTS = "team-comment";
const HL_FOCUS = "team-comment-focus";

function highlightStore(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

/// The range a quoted passage covers under `root`, across text nodes.
function rangeFor(root: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    starts.push(text.length);
    nodes.push(n as Text);
    text += n.nodeValue ?? "";
  }
  const hit = locateQuote(text, quote);
  if (!hit) return null;
  const locate = (offset: number): [Text, number] => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > offset) i--;
    return [nodes[i], offset - starts[i]];
  };
  const [sn, so] = locate(hit[0]);
  const [en, eo] = locate(hit[1] - 1);
  try {
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo + 1);
    return range;
  } catch {
    return null;
  }
}

/// The open file's comments: a pill in its header that lists them, a
/// "Comment on this file", the passages marked in the text, and a Comment
/// button by whatever you select. `focus` scrolls to one passage (a comment
/// opened from the list); a new `focus.n` scrolls again.
export function FileComments({
  task,
  file,
  content,
  ready,
  focus,
}: {
  task: TeamTask;
  file: string;
  /// The rendered file, where selections and passages are.
  content: React.RefObject<HTMLElement>;
  /// The file's text is on screen.
  ready: boolean;
  focus?: { quote: string; n: number } | null;
}) {
  const comments = commentsOnFile(task.comments, file);
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState<{ quote: string; rect: DOMRect } | null>(null);
  const [box, setBox] = useState<{ quote: string; rect: DOMRect } | null>(null);
  const floating = useRef<HTMLButtonElement>(null);
  const quotes = comments.map((c) => c.quote ?? "").join("\u0000");

  // Mark every commented passage. After the markdown has painted: it renders
  // a beat behind its source.
  useEffect(() => {
    const store = highlightStore();
    const root = content.current;
    if (!store || !root || !ready) return;
    const paint = () => {
      const ranges = quotes
        .split("\u0000")
        .filter(Boolean)
        .map((q) => rangeFor(root, q))
        .filter((r): r is Range => !!r);
      if (ranges.length) store.set(HL_COMMENTS, new Highlight(...ranges));
      else store.delete(HL_COMMENTS);
    };
    paint();
    const t = window.setTimeout(paint, 120);
    return () => {
      window.clearTimeout(t);
      store.delete(HL_COMMENTS);
    };
  }, [quotes, ready, content]);

  // Opened from a comment: bring its passage into view and mark it for a moment.
  useEffect(() => {
    const root = content.current;
    if (!focus || !root || !ready) return;
    const store = highlightStore();
    const t = window.setTimeout(() => {
      const range = rangeFor(root, focus.quote);
      if (!range) return;
      range.startContainer.parentElement?.scrollIntoView({ block: "center" });
      store?.set(HL_FOCUS, new Highlight(range));
    }, 140);
    const clear = window.setTimeout(() => store?.delete(HL_FOCUS), 2600);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(clear);
      store?.delete(HL_FOCUS);
    };
  }, [focus?.n, focus?.quote, ready, content]);

  // A selection in the file offers a Comment button beside it.
  // Listens on the document, reading the file's element when it fires: the
  // element only exists once the file has loaded.
  useEffect(() => {
    const check = (e: Event) => {
      if (floating.current?.contains(e.target as Node)) return;
      window.setTimeout(() => {
        const root = content.current;
        if (!root) return setPicked(null);
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPicked(null);
        const range = sel.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return setPicked(null);
        const quote = quoteFromSelection(sel.toString());
        if (!quote) return setPicked(null);
        setPicked({ quote, rect: range.getBoundingClientRect() });
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked(null);
      else if (e.shiftKey) check(e);
    };
    const onScroll = () => setPicked(null);
    document.addEventListener("mouseup", check);
    document.addEventListener("keyup", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", check);
      document.removeEventListener("keyup", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [content]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {comments.length > 0 && (
          <button
            className="mr-auto inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300 hover:bg-amber-400/20"
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
          >
            <CommentGlyph />
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </button>
        )}
        <span className="text-[11px] text-ink-faint">Select text to comment on a passage</span>
        <CommentButton task={task} target={{ kind: "file", file }} label="Comment on this file" />
      </div>
      {listOpen && comments.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-lg bg-card px-3 py-2.5" aria-label="Comments on this file">
          {comments.map((c) => (
            <li key={c.id} className="border-b border-card pb-2 last:border-b-0 last:pb-0">
              <CommentItem c={c} showTopic={!!c.workerName} />
            </li>
          ))}
        </ul>
      )}
      {picked &&
        !box &&
        createPortal(
          <button
            ref={floating}
            // Keeps the selection while it's pressed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setBox(picked);
              setPicked(null);
            }}
            style={{
              position: "fixed",
              top: picked.rect.top < 40 ? picked.rect.bottom + 6 : picked.rect.top - 30,
              left: Math.min(Math.max(picked.rect.right - 80, 8), window.innerWidth - 96),
            }}
            className="z-50 inline-flex items-center gap-1 rounded-md border border-card bg-surface-elevated px-2 py-1 text-[11.5px] font-medium text-ink shadow-lg hover:text-accent"
            aria-label="Comment on the selected passage"
          >
            <CommentGlyph /> Comment
          </button>,
          document.body,
        )}
      {box && (
        <CommentPopover
          task={task}
          target={{ kind: "file", file, quote: box.quote }}
          anchor={box.rect}
          returnFocus={content.current}
          onClose={() => setBox(null)}
        />
      )}
    </>
  );
}
