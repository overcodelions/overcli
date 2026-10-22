// One item of a process, opened up across the whole pane: where it came
// from, the stage track, your call (or what it's stuck on), then tabs for
// where it stands, its journey, what was handed on and the report, with
// who did what and how long it took down the side.
//
// Everything it says is worked out in processView.ts; this only draws it
// and sends what you decide to main ("processes:act").

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Markdown } from "../../Markdown";
import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import { relativeTime } from "../workerDeskSelectors";
import { workerInitials } from "../WorkerAvatar";
import type { ProcessDef, ProcessStage } from "@shared/org/process";
import type { ProcessItemAction, ProcessItemView } from "@shared/types";
import {
  callLine,
  crewRows,
  firstLine,
  handedOnLines,
  itemActions,
  itemLinks,
  itemOrigin,
  journeyRows,
  liveLine,
  OWNER_TURN,
  outcomeView,
  stoppedInfo,
  type OutcomeRow,
  nextSteps,
  sendBackChoices,
  stageCards,
  startedWords,
  timeSplit,
  voteRows,
  whereItStands,
  type JourneyTone,
  type StageCard,
  type VoteRow,
} from "./processView";
import { StageForm, missingAnswers } from "./StageFields";

const primaryBtn = "pil-btn bg-accent border-accent text-white hover:opacity-90";
const plainBtn = "pil-btn border-card-strong bg-surface-elevated text-ink hover:bg-card-strong";
const label = "text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint";
const card = "rounded-xl border border-card bg-surface-elevated";

type Tab = "where" | "journey" | "handed" | "report";

/// The colour of a stage's kind, as the board draws it: a worker sky, a
/// team the accent, a decision amber.
const KIND_INK: Record<ProcessStage["kind"], { text: string; bg: string; bar: string }> = {
  worker: { text: "text-sky-700 dark:text-sky-300", bg: "bg-sky-400/15", bar: "bg-sky-400" },
  team: { text: "text-accent", bg: "bg-accent/15", bar: "bg-accent" },
  people: { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-400/15", bar: "bg-amber-400" },
};

function Icon({ name, size = 16 }: { name: "more" | "scale" | "alert" | "file" | "branch" | "link"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    scale: (
      <>
        <path d="M12 3v18" />
        <path d="M5 8l7-5 7 5" />
        <path d="M3 14h6l-3 5z" />
        <path d="M15 14h6l-3 5z" />
      </>
    ),
    alert: (
      <>
        <path d="M12 3 2 20h20z" />
        <path d="M12 10v4M12 17h.01" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
      </>
    ),
    branch: (
      <>
        <circle cx="7" cy="5.5" r="2" />
        <circle cx="7" cy="18.5" r="2" />
        <circle cx="17" cy="8" r="2" />
        <path d="M7 7.5v9M17 10c0 4-10 2-10 6.5" />
      </>
    ),
    link: (
      <>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      </>
    ),
  };
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {paths[name]}
    </svg>
  );
}

export function ItemPage({
  item,
  process,
  doer,
  onChanged,
  onBack,
}: {
  item: ProcessItemView;
  process: ProcessDef;
  doer: (s: ProcessStage) => string;
  onChanged: () => void;
  /// Back to the process; without it the name is just said.
  onBack?: () => void;
}) {
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  const stages = process.stages;
  const here = stages[item.stageIndex];
  const live = item.status === "active";
  const stage = live ? here : undefined;
  const can = itemActions(item, stage);

  // Times are worked out against a clock that ticks once a minute, so "2 h
  // so far" moves while the page stays open between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [item.updatedAt]);

  const [tab, setTab] = useState<Tab>("where");
  const [busy, setBusy] = useState<ProcessItemAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveTo, setMoveTo] = useState(String(item.stageIndex));
  const back = sendBackChoices(stages, item.stageIndex);
  const [sending, setSending] = useState(false);
  const [backTo, setBackTo] = useState(back.defaultIndex);
  const [why, setWhy] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Where it moves, the send back and move pickers start from its new place.
  useEffect(() => {
    setBackTo(sendBackChoices(stages, item.stageIndex).defaultIndex);
    setMoveTo(String(item.stageIndex));
    setSending(false);
    setAnswers({});
    // Only a move resets them: `stages` is a new array on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.stageIndex]);

  const cards = stageCards(item, stages, doer, now);
  const cur = cards[item.stageIndex] as StageCard | undefined;
  const links = itemLinks(item);
  const stands = whereItStands(item);
  const handed = handedOnLines(item);
  const next = nextSteps(item, stages, doer);
  const journey = journeyRows(item, stages, cur?.status);
  const crew = crewRows(item, stages, doer, now);
  const split = timeSplit(item, stages, now);
  const vote = stage?.kind === "people" ? voteRows(item, stage) : null;
  const deciding = !!stage && stage.kind === "people" && item.canDecide;
  // A team or worker stage stopped for its owner, and that's you.
  const ownerTurn = live && stage && stage.kind !== "people" && item.ownerTurn && item.yourTurn ? OWNER_TURN[item.ownerTurn] : null;
  const outcome = outcomeView(item, stages, doer);
  const stopped = stoppedInfo(item, stages);
  const latest = outcome.last?.artifact;
  const stuck = live && !!item.blocked;
  const openTask = item.taskId && stage?.teamId ? () => selectTeam(stage.teamId!, item.taskId) : null;
  const canSkip = can.move && item.stageIndex < stages.length - 1;

  const act = async (action: ProcessItemAction, extra: { note?: string; stageIndex?: number; answers?: Record<string, string> } = {}): Promise<boolean> => {
    if (action === "stop" && !window.confirm(`Stop ${item.title}? Any team work on it is cancelled; what it produced stays.`)) return false;
    setBusy(action);
    setError(null);
    const text = extra.note?.trim();
    const res = await window.overcli.invoke("processes:act", {
      itemId: item.id,
      action,
      ...(text ? { note: text } : {}),
      ...(extra.stageIndex !== undefined ? { stageIndex: extra.stageIndex } : {}),
      ...(extra.answers ? { answers: extra.answers } : {}),
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    onChanged();
    return true;
  };

  const fields = stage?.kind === "people" ? (stage.fields ?? []) : [];
  const inputStage = stage?.kind === "people" && stage.mode === "input";
  const approve = async () => {
    const missing = missingAnswers(fields, answers);
    if (missing.length) {
      setError(`Fill in ${missing.map((m) => `“${m}”`).join(", ")}.`);
      return;
    }
    if (await act("approve", fields.length ? { answers } : {})) setAnswers({});
  };

  const sendBack = async () => {
    if (!why.trim()) {
      setError("Say what needs to change, so the stage it goes back to knows.");
      return;
    }
    // Main sends it where the stage's "send back to" says; the stage picked
    // here rides along as stageIndex.
    if (await act("sendBack", { note: why, stageIndex: backTo })) {
      setSending(false);
      setWhy("");
    }
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "where", label: item.status === "done" ? "Outcome" : item.status === "stopped" ? "Where it ended" : "Where it stands" },
    { id: "journey", label: "Journey", count: item.history.length },
    { id: "handed", label: "Handed on", count: item.artifacts.length },
    { id: "report", label: "The report" },
  ];

  const backName = stages[backTo]?.name ?? "the stage before";
  const showCall = live && (deciding || (sending && can.sendBack));

  return (
    <div className="pil-page flex w-full min-w-0 flex-col gap-[18px] px-6 pb-10 pt-5">
      <header className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-[3px]">
            <span className="text-xs text-ink-faint">
              {onBack ? (
                <button type="button" className="text-accent hover:underline" onClick={onBack}>
                  {process.name}
                </button>
              ) : (
                <span className="text-ink-muted">{process.name}</span>
              )}
              {" · "}
              {itemOrigin(item)} · started {startedWords(item.createdAt, now)}
              {process.codeIn && (
                <span title={process.codeIn.path}> · code in {process.codeIn.name}</span>
              )}
            </span>
            <h1 className="m-0 text-[22px] font-semibold leading-tight text-ink">{item.title}</h1>
            {firstLine(item.brief) && <span className="text-[12.5px] text-ink-muted">{firstLine(item.brief)}</span>}
          </div>
          <div className="relative flex flex-wrap items-center gap-2.5">
            <span className="rounded-full border border-card px-2.5 py-1 text-xs text-ink-muted">Owner · {process.owner.name}</span>
            <button type="button" className={plainBtn} aria-expanded={noteOpen} onClick={() => setNoteOpen((v) => !v)}>
              Add a note
            </button>
            <OverflowMenu open={menuOpen} onOpen={setMenuOpen}>
              {can.startNow && (
                <MenuItem disabled={!!busy} onClick={() => void act("startNow")}>
                  {busy === "startNow" ? "Starting…" : "Start now"}
                </MenuItem>
              )}
              {openTask && <MenuItem onClick={openTask}>Open the task</MenuItem>}
              {can.retry && !item.startsAt && (
                <MenuItem disabled={!!busy} onClick={() => void act("retry")}>
                  {busy === "retry" ? "Starting…" : "Start this stage again"}
                </MenuItem>
              )}
              {can.sendBack && !deciding && back.choices.length > 0 && (
                <MenuItem
                  onClick={() => {
                    setSending(true);
                    setMenuOpen(false);
                  }}
                >
                  Send back…
                </MenuItem>
              )}
              {can.move && (
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <label htmlFor="pil-move" className="sr-only">
                    Move to stage
                  </label>
                  <select id="pil-move" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="field min-w-0 flex-1 px-2 py-1 text-xs">
                    {stages.map((s, i) => (
                      <option key={s.id} value={i}>
                        {i + 1}. {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-md border border-card-strong px-2 py-1 text-xs text-ink hover:bg-card-strong disabled:opacity-40"
                    disabled={!!busy || Number(moveTo) === item.stageIndex}
                    onClick={() => void act("move", { stageIndex: Number(moveTo) }).then((ok) => ok && setMenuOpen(false))}
                  >
                    Move
                  </button>
                </div>
              )}
              {can.stop && (
                <MenuItem danger disabled={!!busy} onClick={() => void act("stop")}>
                  Stop it
                </MenuItem>
              )}
              {!can.startNow && !openTask && !can.retry && !can.move && !can.stop && !can.sendBack && (
                <span className="block px-3 py-2 text-xs text-ink-faint">Nothing else to do here.</span>
              )}
            </OverflowMenu>
          </div>
        </div>

        {noteOpen && (
          <div className="flex flex-col gap-2 rounded-xl border border-card bg-surface-elevated p-3">
            <label htmlFor="pil-note" className="text-[12.5px] text-ink-muted">
              A note on this item, passed on to the stage it's at
            </label>
            <textarea id="pil-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="field resize-y px-2.5 py-2 text-[13px] leading-relaxed" />
            <div className="flex gap-2">
              <button
                type="button"
                className={primaryBtn}
                disabled={!!busy || !note.trim()}
                onClick={() =>
                  void act("note", { note }).then((ok) => {
                    if (ok) {
                      setNote("");
                      setNoteOpen(false);
                    }
                  })
                }
              >
                {busy === "note" ? "Adding…" : "Add the note"}
              </button>
              <button type="button" className={plainBtn} onClick={() => setNoteOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <ol aria-label="Stages" className="pil-track m-0 grid list-none gap-2 p-0">
          {cards.map((c) => (
            <li
              key={c.stage.id}
              aria-current={c.index === item.stageIndex && live ? "step" : undefined}
              className={
                "flex min-w-0 flex-col gap-[3px] rounded-[10px] border px-3 py-2.5 " +
                (c.mine ? "pil-amber" : c.state === "stuck" ? "border-red-400/40 bg-red-400/5" : "border-card bg-surface-elevated")
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={
                    "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " +
                    (c.state === "done"
                      ? "bg-emerald-400 text-black"
                      : c.state === "stuck"
                        ? "bg-red-400 text-black"
                        : c.state === "now"
                          ? c.mine || c.stage.kind === "people"
                            ? "bg-amber-400 text-black"
                            : "bg-accent text-white"
                          : "bg-card-strong text-ink-muted")
                  }
                >
                  {c.index + 1}
                </span>
                <b className="truncate text-[13px] font-semibold text-ink">{c.stage.name}</b>
              </span>
              <span className="truncate text-[11.5px] text-ink-muted" title={c.who}>
                {c.who}
              </span>
              <span
                className={
                  "text-[11.5px] " +
                  (c.state === "done" ? "text-emerald-700 dark:text-emerald-300" : c.state === "stuck" ? "text-red-700 dark:text-red-300" : c.mine ? "text-amber-700 dark:text-amber-300" : c.state === "now" ? "text-ink" : "text-ink-faint")
                }
              >
                {c.status}
              </span>
            </li>
          ))}
        </ol>
      </header>

      {stuck && (
        <section aria-label="Stuck" className="flex flex-wrap items-center gap-4 rounded-xl border border-red-400/40 bg-red-400/10 px-[18px] py-3.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-red-400/20 text-red-700 dark:text-red-300">
            <Icon name="alert" size={18} />
          </span>
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-0.5">
            <b className="text-[14.5px] font-semibold text-ink">Stuck at {here?.name ?? "this stage"}</b>
            <span className="text-[12.5px] text-ink-muted">{item.blocked}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {can.retry && (
              <button type="button" className={primaryBtn} disabled={!!busy} onClick={() => void act("retry")}>
                {busy === "retry" ? "Starting…" : "Retry"}
              </button>
            )}
            {canSkip && (
              <button
                type="button"
                className={plainBtn}
                disabled={!!busy}
                onClick={() => {
                  const to = stages[item.stageIndex + 1];
                  if (window.confirm(`Skip ${here?.name ?? "this stage"} and move it on to ${to.name}?`)) void act("move", { stageIndex: item.stageIndex + 1 });
                }}
              >
                Skip to {stages[item.stageIndex + 1].name}
              </button>
            )}
            {openTask && (
              <button type="button" className={plainBtn} onClick={openTask}>
                Open the task
              </button>
            )}
          </div>
        </section>
      )}

      {ownerTurn && stage && (
        <section aria-label="Your turn" className="pil-amber flex flex-wrap items-center gap-4 rounded-xl px-[18px] py-3.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-400/20 text-amber-700 dark:text-amber-300">
            <Icon name="scale" size={18} />
          </span>
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-0.5">
            <b className="text-[14.5px] font-semibold text-ink">
              {ownerTurn.title}: {stage.name}
            </b>
            <span className="text-[12.5px] text-ink-muted">
              {doer(stage)} stopped for you, its stage owner{item.stageNote ? `. ${item.stageNote}` : ""}.
              {item.ownerTurn === "pack" ? " Once you sign it off, it moves on." : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {openTask ? (
              <button type="button" className={primaryBtn} onClick={openTask}>
                {item.ownerTurn === "pack" ? "Review and sign off" : item.ownerTurn === "questions" ? "Answer them" : item.ownerTurn === "plan" ? "Review the plan" : "Open the run"}
              </button>
            ) : (
              <span className="text-xs text-ink-faint">Open it from the team or worker that's doing it.</span>
            )}
            {links.prs[0] && (
              <a href={links.prs[0].url} target="_blank" rel="noreferrer" className={plainBtn + " no-underline"}>
                Open {links.prs[0].label}
              </a>
            )}
          </div>
        </section>
      )}

      {showCall && stage && (
        <section aria-label="Your call" className={"flex flex-col gap-3 rounded-xl px-[18px] py-3.5 " + (deciding ? "pil-amber" : "border border-card bg-surface-elevated")}>
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-400/20 text-amber-700 dark:text-amber-300">
              <Icon name="scale" size={18} />
            </span>
            <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-0.5">
              <b className="text-[14.5px] font-semibold text-ink">{deciding ? `Your call: ${stage.name}` : `Send ${item.title} back`}</b>
              <span className="text-[12.5px] text-ink-muted">{deciding ? callLine(item, stage, now) : `It's at ${stage.name}, waiting on its decision.`}</span>
              {deciding && stage.ask?.trim() && <span className="text-[12.5px] text-ink-faint">{stage.ask.trim()}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {can.approve && (
                <button type="button" className={primaryBtn} disabled={!!busy} onClick={() => void approve()}>
                  {busy === "approve" ? (inputStage ? "Submitting…" : "Approving…") : inputStage ? "Submit" : "Approve"}
                </button>
              )}
              {can.sendBack && back.choices.length > 0 && deciding && (
                <button type="button" className={plainBtn} aria-expanded={sending} onClick={() => setSending((v) => !v)}>
                  Send back…
                </button>
              )}
              {links.prs[0] && (
                <a href={links.prs[0].url} target="_blank" rel="noreferrer" className={plainBtn + " no-underline"}>
                  Open {links.prs[0].label}
                </a>
              )}
            </div>
          </div>
          {deciding && can.approve && !sending && fields.length > 0 && <StageForm fields={fields} answers={answers} onChange={setAnswers} />}
          {sending && (
            <div className="flex flex-col gap-2.5 border-t border-amber-400/25 pt-3">
              <span className="text-[12.5px] text-ink-muted">Send it back to</span>
              <div role="group" aria-label="Send back to" className="flex flex-wrap gap-1.5">
                {back.choices.map((b) => (
                  <button
                    key={b.index}
                    type="button"
                    aria-pressed={backTo === b.index}
                    onClick={() => setBackTo(b.index)}
                    className={
                      "rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold " +
                      (backTo === b.index ? "border-amber-400 bg-amber-400/15 text-amber-700 dark:text-amber-300" : "border-card-strong text-ink-muted hover:text-ink")
                    }
                  >
                    {b.name}
                    {b.index === back.defaultIndex ? " (usual)" : ""}
                  </button>
                ))}
              </div>
              <label htmlFor="pil-why" className="text-[12.5px] text-ink-muted">
                What needs to change
              </label>
              <textarea
                id="pil-why"
                rows={2}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                placeholder="e.g. Stream the rows instead of building the file in memory"
                className="field resize-y px-2.5 py-2 text-[13px] leading-relaxed"
              />
              <div className="flex gap-2">
                <button type="button" className={primaryBtn} disabled={!!busy || !why.trim()} onClick={() => void sendBack()}>
                  {busy === "sendBack" ? "Sending back…" : `Send back to ${backName}`}
                </button>
                <button
                  type="button"
                  className={plainBtn}
                  onClick={() => {
                    setSending(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {error && (
        <div role="alert" className="-mt-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <main className="flex min-w-0 flex-[999_1_640px] flex-col gap-3.5">
          <div role="tablist" aria-label="Item views" className="pil-tabs">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="pil-tab" onClick={() => setTab(t.id)}>
                {t.label}
                {t.count !== undefined && <span className="pil-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>

          {tab === "where" && item.status === "done" && (
            <div className="flex flex-col gap-3.5" role="tabpanel">
              {outcome.last ? (
                <ArtifactCard artifact={outcome.last.artifact} heading={`The outcome · from ${outcome.last.artifact.stageName}`} stages={stages} now={now} lead />
              ) : (
                <div className={card + " px-5 py-[18px] text-[13px] text-ink-muted"}>It made it through {process.name}, with nothing handed on.</div>
              )}
              {outcome.earlier.length > 0 && <EarlierPacks rows={outcome.earlier} heading="Along the way" stages={stages} now={now} />}
            </div>
          )}

          {tab === "where" && item.status === "stopped" && (
            <div className="flex flex-col gap-3.5" role="tabpanel">
              <div className={card + " flex flex-col gap-2 border-red-400/30 px-5 py-[18px]"}>
                <span className={label + " !text-red-700 dark:!text-red-300"}>Stopped</span>
                <p className="m-0 text-[15px] font-medium text-ink">
                  Stopped at {stopped.stage}
                  {stopped.by ? ` by ${stopped.by}` : ""}
                  {stopped.at ? `, ${startedWords(stopped.at, now)}` : ""}.
                </p>
                <span className="text-[13px] text-ink-muted">{stopped.why ? `“${stopped.why}”` : "No reason was given."}</span>
              </div>
              {outcome.last ? (
                <EarlierPacks rows={[...outcome.earlier, outcome.last]} heading="What was handed on before it stopped" stages={stages} now={now} />
              ) : (
                <div className={card + " px-5 py-4 text-[13px] text-ink-faint"}>Nothing was handed on before it stopped.</div>
              )}
            </div>
          )}

          {tab === "where" && live && (
            <div className="flex flex-col gap-3.5" role="tabpanel">
              <div className={card + " flex flex-col gap-3 px-5 py-[18px]"}>
                <span className={"flex items-center gap-2 text-[13px] font-semibold " + (item.yourTurn ? "text-amber-700 dark:text-amber-300" : stuck ? "text-red-700 dark:text-red-300" : "text-ink")}>
                  <span className={"h-2 w-2 shrink-0 rounded-full " + (item.yourTurn ? "bg-amber-400" : stuck ? "bg-red-400" : "bg-accent")} />
                  {liveLine(item, here, doer)}
                </span>
                <span className={label}>{stands.from ? `Last handed on · from ${stands.from}` : `Where it stands · ${here?.name ?? ""}`}</span>
                <Collapsible className="pil-lead text-[15px] font-medium leading-relaxed text-ink" source={stands.text} />
                {latest && stands.from && <ArtifactFiles artifact={latest} />}
                {(links.prs.length > 0 || links.branches.length > 0 || openTask) && (
                  <div className="flex flex-wrap gap-2">
                    {links.prs.map((p) => (
                      <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="pil-chip hover:text-ink">
                        <Icon name="link" size={13} />
                        {p.label}
                      </a>
                    ))}
                    {links.branches.map((b) => (
                      <span key={b} className="pil-chip font-mono">
                        <Icon name="branch" size={13} />
                        {b}
                      </span>
                    ))}
                    {openTask && (
                      <button type="button" className="pil-chip hover:text-ink" onClick={openTask}>
                        Open the task
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="pil-cards grid gap-3">
                {vote && stage && (
                  <div className={card + " flex flex-col gap-2.5 px-4 py-3.5"}>
                    <span className={label + " !text-amber-700 dark:!text-amber-300"}>
                      The vote · {vote.have} of {vote.need} needed
                    </span>
                    {vote.rows.map((v) => (
                      <VoteLine key={`${v.group ? "g" : "p"}:${v.name}`} row={v} now={now} />
                    ))}
                  </div>
                )}
                <div className={card + " flex flex-col gap-2.5 px-4 py-3.5"}>
                  <span className={label}>Handed on so far</span>
                  {handed.length === 0 ? (
                    <span className="text-[12.5px] text-ink-faint">Nothing yet. Each stage's pack shows up here as it finishes.</span>
                  ) : (
                    handed.map((h) => (
                      <div key={h.key} className="flex flex-col gap-0.5">
                        <span className="text-[13px] font-semibold text-ink">{h.stage}</span>
                        <span className="text-xs text-ink-muted">{h.line}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className={card + " flex flex-col gap-2.5 px-4 py-3.5"}>
                  <span className={label + " !text-accent"}>What happens next</span>
                  {next.map((x) => (
                    <div key={x} className="flex items-start gap-2.5">
                      <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-accent" />
                      <span className="text-[13px] text-ink">{x}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "journey" && (
            <div role="tabpanel" className={card + " flex flex-col px-5 py-[18px]"}>
              {journey.map((j, i) => (
                <div key={j.key} className="flex gap-3.5">
                  <div className="flex w-3.5 shrink-0 flex-col items-center">
                    <span className={"mt-1 h-3 w-3 shrink-0 rounded-full " + TONE_DOT[j.tone]} />
                    <span className={"w-0.5 flex-1 " + (i === journey.length - 1 ? "bg-transparent" : "bg-card-strong")} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 pb-[18px]">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <b className="text-[13.5px] font-semibold text-ink">{j.title}</b>
                      <span className="text-xs text-ink-faint">{j.at === null ? "now" : startedWords(j.at, now)}</span>
                      {j.tag && <span className={"pil-pill " + TAG_LOOK[j.tag]}>{j.tag}</span>}
                    </span>
                    {j.detail && <span className="whitespace-pre-wrap text-[12.5px] text-ink-muted">{j.detail}</span>}
                    {j.artifact !== undefined && item.artifacts[j.artifact] && <ArtifactFiles artifact={item.artifacts[j.artifact]} />}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "handed" && (
            <div role="tabpanel" className={card + " overflow-hidden"}>
              {item.artifacts.length === 0 ? (
                <p className="m-0 px-4 py-6 text-center text-[13px] text-ink-faint">No stage has handed anything on yet.</p>
              ) : (
                [...item.artifacts]
                  .sort((a, b) => a.at - b.at)
                  .map((a, i) => {
                    const teamId = stages.find((s) => s.id === a.stageId)?.teamId;
                    return (
                      <div key={`${a.stageId}:${a.at}:${i}`} className={"flex flex-col gap-2 px-4 py-3 " + (i ? "border-t border-card" : "")}>
                        <span className="flex flex-wrap items-baseline gap-2">
                          <b className="text-[13px] font-semibold text-ink">{a.title}</b>
                          <span className="text-xs text-ink-faint">
                            {a.stageName} · {relativeTime(a.at, now)}
                          </span>
                          <span className="flex-1" />
                          {a.taskId && teamId && (
                            <button type="button" className="text-xs text-accent hover:underline" onClick={() => selectTeam(teamId, a.taskId)}>
                              Open the task
                            </button>
                          )}
                        </span>
                        {a.summary && <Collapsible className="text-[12.5px] text-ink-muted" source={a.summary} />}
                        {a.branch && (
                          <span className="flex items-center gap-1 font-mono text-[11.5px] text-ink-faint">
                            <Icon name="branch" size={12} />
                            {a.branch}
                          </span>
                        )}
                        <ArtifactFiles artifact={a} />
                      </div>
                    );
                  })
              )}
            </div>
          )}

          {tab === "report" && (
            <div role="tabpanel" className={card + " flex flex-col gap-2 px-[18px] py-4"}>
              <span className={label}>The report · from {item.initiator.name}</span>
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-ink">{item.brief}</p>
              {item.sourceUrl && (
                <a className="self-start text-xs text-accent hover:underline" href={item.sourceUrl} target="_blank" rel="noreferrer">
                  Where it came from
                </a>
              )}
            </div>
          )}
        </main>

        <aside aria-label="Who does each stage" className="flex min-w-0 max-w-full flex-[1_1_300px] flex-col gap-3.5">
          <div className={card + " flex flex-col gap-3 px-4 py-3.5"}>
            <span className={label}>Who does what</span>
            {crew.map((c) => (
              <div key={c.stage.id} className="flex items-center gap-2.5">
                <span
                  className={"inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-[11.5px] font-bold " + KIND_INK[c.stage.kind].text + " " + KIND_INK[c.stage.kind].bg}
                  title={c.stage.kind === "worker" ? "A worker" : c.stage.kind === "team" ? "A team" : "People decide"}
                >
                  {c.badge}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-ink">{c.stage.name}</span>
                  <span className="truncate text-[11.5px] text-ink-faint">{c.who}</span>
                </span>
                <span className="shrink-0 text-[11.5px] text-ink-muted">{c.took}</span>
              </div>
            ))}
          </div>
          <div className={card + " flex flex-col gap-2 px-4 py-3.5"}>
            <span className={label}>Time so far</span>
            {split.total > 0 && (
              <div className="flex h-2 gap-0.5 overflow-hidden rounded" role="img" aria-label={split.caption}>
                {split.parts.map((p) => (
                  <span key={p.stage.id} className={KIND_INK[p.stage.kind].bar} style={{ flex: p.ms }} title={p.stage.name} />
                ))}
              </div>
            )}
            <span className="text-xs text-ink-muted">{split.caption}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

const TONE_DOT: Record<JourneyTone, string> = {
  start: "bg-ink-faint",
  done: "bg-emerald-400",
  redo: "bg-red-400",
  stuck: "bg-red-400",
  note: "bg-accent",
  now: "bg-amber-400",
};

const TAG_LOOK: Record<"Redo" | "Now" | "Stuck", string> = {
  Redo: "bg-red-400/15 text-red-700 dark:text-red-300",
  Stuck: "bg-red-400/15 text-red-700 dark:text-red-300",
  Now: "bg-amber-400/15 text-amber-700 dark:text-amber-300",
};

function VoteLine({ row, now }: { row: VoteRow; now: number }) {
  const look =
    row.state === "approved"
      ? { av: "text-emerald-700 dark:text-emerald-300", chip: "bg-emerald-400/15 text-emerald-700 dark:text-emerald-300", word: "Approved" }
      : row.state === "waiting"
        ? { av: "text-amber-700 dark:text-amber-300", chip: "bg-amber-400/15 text-amber-700 dark:text-amber-300", word: "Waiting" }
        : { av: "text-ink-faint", chip: "bg-card-strong text-ink-muted", word: "Not needed" };
  const note = row.state === "approved" ? [row.at ? relativeTime(row.at, now) : "", row.note ? `“${row.note}”` : ""].filter(Boolean).join(" · ") : row.note ?? (row.you ? "Asked here" : "");
  return (
    <div className="flex items-center gap-2.5">
      <span className={"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card-strong text-[11px] font-bold " + look.av}>{workerInitials(row.name)}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-ink">{row.name}</span>
        {note && <span className="truncate text-[11.5px] text-ink-faint">{note}</span>}
      </span>
      <span className={"pil-pill " + look.chip}>{look.word}</span>
    </div>
  );
}

/// The "…" button and what it opens: the item's other actions. Closes on a
/// click outside or Escape.
function OverflowMenu({ open, onOpen, children }: { open: boolean; onOpen: (v: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, onOpen]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={plainBtn + " !px-2.5"} aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 flex w-64 flex-col rounded-xl border border-card-strong bg-surface-elevated p-1 shadow-xl">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, disabled, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={"rounded-lg px-3 py-2 text-left text-[12.5px] hover:bg-card-strong disabled:opacity-40 " + (danger ? "text-red-700 dark:text-red-300" : "text-ink")}
    >
      {children}
    </button>
  );
}

type Artifact = ProcessItemView["artifacts"][number];

/// Markdown that folds past about twelve lines, with "Show all".
function Collapsible({ source, className = "" }: { source: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [source, open]);
  return (
    <div className="flex flex-col gap-1">
      <div ref={ref} className={className + (open ? "" : long ? " pil-clamp pil-clamp-fade" : " pil-clamp")}>
        <Markdown source={source} />
      </div>
      {(long || open) && (
        <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/// A pack's files, each opening in place (and in its app from there). A
/// pack from a task that isn't on this computer, an org server's, says so.
function ArtifactFiles({ artifact }: { artifact: Artifact }) {
  const loaded = useTeamsStore((s) => s.loaded);
  const known = useTeamsStore((s) => (artifact.taskId ? !!s.tasks[artifact.taskId] : false));
  const [shown, setShown] = useState<string | null>(null);
  if (!artifact.files.length) return null;
  const here = !!artifact.taskId && (!loaded || known);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col">
        {artifact.files.map((f) => (
          <div key={f} className="flex flex-col">
            <button
              type="button"
              disabled={!here}
              aria-expanded={shown === f}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-card-strong disabled:cursor-default disabled:hover:bg-transparent"
              onClick={() => setShown(shown === f ? null : f)}
            >
              <span className="text-ink-faint">
                <Icon name="file" size={14} />
              </span>
              <span className="min-w-0 truncate font-mono">{f}</span>
              {!here && <span className="ml-auto shrink-0 text-[11px] text-ink-faint">not on this computer</span>}
            </button>
            {shown === f && artifact.taskId && <FilePreview taskId={artifact.taskId} name={f} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/// One file of a pack, read from its task's shared folder and shown as markdown.
function FilePreview({ taskId, name }: { taskId: string; name: string }) {
  const readFile = useTeamsStore((s) => s.readFile);
  const openFile = useTeamsStore((s) => s.openFile);
  const [state, setState] = useState<{ body?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState({});
    void readFile(taskId, name).then((res) => {
      if (live) setState(res.ok ? { body: res.body } : { error: res.error });
    });
    return () => {
      live = false;
    };
  }, [taskId, name, readFile]);
  return (
    <div className="mb-2 ml-7 flex flex-col gap-2 rounded-lg border border-card bg-surface px-4 py-3">
      {state.error ? (
        <span className="text-xs text-ink-faint">It isn't on this computer: {state.error}</span>
      ) : state.body === undefined ? (
        <span className="text-xs text-ink-faint">Loading…</span>
      ) : (
        <>
          <Collapsible className="text-[12.5px] text-ink" source={state.body} />
          <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => void openFile(taskId, name)}>
            Open in its app
          </button>
        </>
      )}
    </div>
  );
}

/// One pack in full: its summary, chips for its branch and PRs, its task, its files.
function ArtifactCard({ artifact, heading, stages, now, lead }: { artifact: Artifact; heading: string; stages: readonly ProcessStage[]; now: number; lead?: boolean }) {
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  const teamId = stages.find((s) => s.id === artifact.stageId)?.teamId;
  const links = itemLinks({ artifacts: [artifact] });
  return (
    <div className={card + " flex flex-col gap-3 px-5 py-[18px]"}>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className={label}>{heading}</span>
        <span className="text-xs text-ink-faint">{relativeTime(artifact.at, now)}</span>
      </span>
      {artifact.title && artifact.title !== artifact.stageName && <b className="text-[14px] font-semibold text-ink">{artifact.title}</b>}
      <Collapsible className={lead ? "pil-lead text-[15px] leading-relaxed text-ink" : "text-[13px] text-ink-muted"} source={artifact.summary} />
      {(links.prs.length > 0 || links.branches.length > 0 || (artifact.taskId && teamId)) && (
        <div className="flex flex-wrap gap-2">
          {links.prs.map((p) => (
            <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="pil-chip hover:text-ink">
              <Icon name="link" size={13} />
              {p.label}
            </a>
          ))}
          {links.branches.map((b) => (
            <span key={b} className="pil-chip font-mono">
              <Icon name="branch" size={13} />
              {b}
            </span>
          ))}
          {artifact.taskId && teamId && (
            <button type="button" className="pil-chip hover:text-ink" onClick={() => selectTeam(teamId, artifact.taskId)}>
              Open the task
            </button>
          )}
        </div>
      )}
      <ArtifactFiles artifact={artifact} />
    </div>
  );
}

/// The packs before the last, one line each ("Gather evidence · Product
/// Team · 2 files"), each opening to its summary and files.
function EarlierPacks({ rows, heading, stages, now }: { rows: OutcomeRow[]; heading: string; stages: readonly ProcessStage[]; now: number }) {
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  return (
    <div className={card + " flex flex-col overflow-hidden"}>
      <span className={label + " px-4 pb-1 pt-3.5"}>{heading}</span>
      {rows.map((r, i) => {
        const a = r.artifact;
        const teamId = stages.find((s) => s.id === a.stageId)?.teamId;
        return (
          <details key={`${a.stageId}:${a.at}:${r.index}`} className={"pil-pack " + (i ? "border-t border-card" : "")}>
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-[13px] text-ink hover:bg-card-strong">
              <span className="pil-caret text-ink-faint" aria-hidden>
                ›
              </span>
              <span className="min-w-0 flex-1 truncate">{r.line}</span>
              <span className="shrink-0 text-xs text-ink-faint">{relativeTime(a.at, now)}</span>
            </summary>
            <div className="flex flex-col gap-2 px-4 pb-3 pl-9">
              {a.title && a.title !== a.stageName && <b className="text-[13px] font-semibold text-ink">{a.title}</b>}
              <Collapsible className="text-[12.5px] text-ink-muted" source={a.summary} />
              {a.branch && (
                <span className="flex items-center gap-1 font-mono text-[11.5px] text-ink-faint">
                  <Icon name="branch" size={12} />
                  {a.branch}
                </span>
              )}
              <ArtifactFiles artifact={a} />
              {a.taskId && teamId && (
                <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => selectTeam(teamId, a.taskId)}>
                  Open the task
                </button>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
