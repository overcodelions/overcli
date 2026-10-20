import { describe, expect, it } from "vitest";
import { validateProcess, type ProcessStage } from "@shared/org/process";
import type { ProcessItemView } from "@shared/types";
import { PROCESS_LIBRARY, libraryProcess } from "@shared/org/processLibrary";
import {
  boardColumns,
  goodMatches,
  historyLine,
  itemActions,
  libraryByCategory,
  libraryDraft,
  libraryStageFor,
  pictureEditorDraft,
  matchWords,
  boardStats,
  durationWords,
  filterItems,
  itemJourney,
  itemSource,
  itemTrack,
  nowCard,
  stageMoreAtDefaults,
  waysInSummary,
  delayOptions,
  moveStage,
  parseWatchArgs,
  repeatFromKey,
  repeatKey,
  repeatOptions,
  scheduleCadence,
  timingText,
  newStage,
  pickerSections,
  rankDoers,
  removeStage,
  sendBackName,
  stageMatchText,
  stageMissing,
  stageReady,
  teamBriefFor,
  teamOptions,
  workerOptions,
  callLine,
  crewRows,
  firstLine,
  firstSentence,
  handedOnLines,
  itemLinks,
  itemOrigin,
  journeyRows,
  liveLine,
  nextSteps,
  nowLine,
  outcomeView,
  sendBackChoices,
  shortSpan,
  stageCards,
  stageTimes,
  startedWords,
  stoppedInfo,
  timeSplit,
  voteRows,
  voteRuleText,
  whereItStands,
  endToEnd,
  filterCounts,
  flowDrawing,
  flowMinWidth,
  flowPadding,
  flowPlan,
  outcomeLine,
  pageStats,
  quietSummary,
  recentFinished,
  recentTrack,
  stageDurations,
  stageSentence,
  stageTimeWords,
  timeBars,
  waysInPhrase,
  waysInShort,
  FLOW_LANE,
  FLOW_EDGE,
} from "./processView";

function item(over: Partial<ProcessItemView> = {}): ProcessItemView {
  return {
    id: "i1",
    processId: "p1",
    title: "Acme sign-up flow",
    brief: "Make sign-up one step",
    initiator: { name: "You" },
    source: "desktop",
    stageIndex: 0,
    status: "active",
    artifacts: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    stageName: "Prototype",
    canDecide: false,
    canSteer: true,
    yourTurn: false,
    ...over,
  };
}

describe("the process library", () => {
  it("groups every library process by category, in a fixed order", () => {
    const groups = libraryByCategory();
    expect(groups.map((g) => g.category)).toEqual(["Product", "Engineering", "Customers", "Go to market", "Security and operations"]);
    expect(groups.flatMap((g) => g.processes).length).toBe(PROCESS_LIBRARY.length);
    expect(groups[0].processes[0].id).toBe("idea-to-launch");
    expect(groups.every((g) => g.processes.every((p) => p.category === g.category))).toBe(true);
  });

  it("leaves out empty categories", () => {
    const one = PROCESS_LIBRARY.filter((p) => p.category === "Customers");
    expect(libraryByCategory(one).map((g) => g.category)).toEqual(["Customers"]);
  });

  it("drafts the editor from a library process, matching teams and making you the decider", () => {
    const p = libraryProcess("idea-to-launch")!;
    const draft = libraryDraft(p, [
      { id: "t-design", name: "Acme design crew", purpose: "UX research and prototypes", members: [{ role: "UX designer" }] },
      { id: "t-dev", name: "Acme platform engineering", members: [{ role: "Developer" }, { role: "Code reviewer" }] },
    ]);
    expect(draft).toMatchObject({ name: p.name, purpose: p.summary, about: p.about, templateId: "idea-to-launch" });
    expect(draft.stages.map((s) => s.id)).toEqual(p.stages.map((s) => s.key));
    expect(draft.stages.every((s) => s.ask && s.why)).toBe(true);
    expect(draft.stages.find((s) => s.id === "proto")?.teamId).toBe("t-design");
    expect(draft.stages.find((s) => s.id === "build")?.teamId).toBe("t-dev");
    expect(draft.stages.find((s) => s.id === "prfaq")?.teamId).toBeUndefined();
    expect(draft.stages.find((s) => s.id === "validate")).toMatchObject({ kind: "people", approvers: [{ name: "You" }] });
  });

  it("drafts a process that saves once every team stage has a team", () => {
    for (const p of PROCESS_LIBRARY) {
      const stages = libraryDraft(p, []).stages.map((s) => (s.kind === "team" ? { ...s, teamId: "t1" } : s));
      expect(validateProcess({ name: p.name, owner: { name: "You" }, stages }, new Set(["t1"]))).toBeNull();
    }
  });

  it("finds a stage's library stage by template and stage id", () => {
    expect(libraryStageFor("idea-to-launch", "proto")?.crew).toContain("UX designer");
    expect(libraryStageFor("idea-to-launch", "nope")).toBeUndefined();
    expect(libraryStageFor(undefined, "proto")).toBeUndefined();
  });

  it("writes a team brief naming the stage, its job and its crew", () => {
    const stage = libraryStageFor("idea-to-launch", "proto")!;
    const brief = teamBriefFor(stage, "Idea to launch");
    expect(brief).toContain('"Prototype" stage of Idea to launch');
    expect(brief).toContain(stage.ask);
    expect(brief).toContain("It needs: UX designer, Prototype builder, Usability reviewer.");
  });
});

describe("stage edits", () => {
  const a = newStage("team", "A");
  const b = newStage("people", "B");
  const c: ProcessStage = { ...newStage("team", "C"), sendBackTo: a.id };

  it("moves a stage up or down, and leaves the ends alone", () => {
    expect(moveStage([a, b, c], 1, -1).map((s) => s.name)).toEqual(["B", "A", "C"]);
    expect(moveStage([a, b, c], 1, 1).map((s) => s.name)).toEqual(["A", "C", "B"]);
    expect(moveStage([a, b, c], 0, -1)).toEqual([a, b, c]);
    expect(moveStage([a, b, c], 2, 1)).toEqual([a, b, c]);
  });

  it("clears a send-back that pointed at a removed stage", () => {
    const left = removeStage([a, b, c], 0);
    expect(left.map((s) => s.name)).toEqual(["B", "C"]);
    expect(left[1].sendBackTo).toBeUndefined();
  });
});

describe("boardColumns", () => {
  it("puts live items under their stage, latest first, and leaves finished ones off", () => {
    const stages = [newStage("team", "A"), newStage("people", "B")];
    const cols = boardColumns(stages, [
      item({ id: "x", stageIndex: 1, updatedAt: 5 }),
      item({ id: "y", stageIndex: 1, updatedAt: 9 }),
      item({ id: "z", stageIndex: 0, status: "done" }),
    ]);
    expect(cols.map((c) => c.items.map((i) => i.id))).toEqual([[], ["y", "x"]]);
  });
});

describe("itemActions", () => {
  const team = newStage("team", "Build");
  const people = newStage("people", "Decide");

  it("offers a decision only at a people stage, to someone who decides", () => {
    expect(itemActions(item({ canDecide: true }), people)).toMatchObject({ approve: true, sendBack: true, retry: false });
    expect(itemActions(item({ canDecide: false, canSteer: false }), people)).toMatchObject({ approve: false, sendBack: false, stop: false });
  });

  it("offers starting again at a team stage, and nothing on a finished item", () => {
    expect(itemActions(item(), team)).toMatchObject({ approve: false, retry: true, move: true, stop: true });
    expect(Object.values(itemActions(item({ status: "done" }), team)).some(Boolean)).toBe(false);
  });
});

describe("historyLine", () => {
  const stages: ProcessStage[] = [{ id: "p", name: "Prototype", kind: "team", teamId: "t" }];
  it("says who did what, where", () => {
    expect(historyLine({ at: 1, kind: "sentBack", stageId: "p", by: "You", note: "Add pricing." }, stages)).toBe("Sent back to Prototype by You: Add pricing.");
    expect(historyLine({ at: 1, kind: "entered", stageId: "p" }, stages)).toBe("Started · Prototype");
    expect(historyLine({ at: 1, kind: "done" }, stages)).toBe("Made it through");
  });
});

describe("the editor's map", () => {
  it("says which stages can't run yet, and where send back goes", async () => {
    const { stageReady, sendBackName } = await import("./processView");
    const stages = [
      { id: "a", name: "Write it up", kind: "team" as const, teamId: "t1" },
      { id: "b", name: "Prototype", kind: "team" as const },
      { id: "c", name: "Decide", kind: "people" as const, approvers: [] },
      { id: "d", name: "Decide again", kind: "people" as const, approvers: [{ name: "You" }], sendBackTo: "a" },
    ];
    const teams = new Set(["t1"]);
    expect(stages.map((s) => stageReady(s, teams))).toEqual([true, false, false, true]);
    expect(sendBackName(stages, 2)).toBe("Prototype");
    expect(sendBackName(stages, 3)).toBe("Write it up");
    expect(sendBackName(stages, 0)).toBe("the start");
  });
});


describe("worker stages", () => {
  it("starts with no worker and nobody deciding", () => {
    const s = newStage("worker", "Summarise");
    expect(s).toMatchObject({ kind: "worker", name: "Summarise" });
    expect(s.approvers).toBeUndefined();
  });

  it("is ready only with a worker still in the crew", () => {
    const crew = new Set(["w1"]);
    expect(stageReady({ id: "a", name: "A", kind: "worker" }, new Set(), crew)).toBe(false);
    expect(stageReady({ id: "a", name: "A", kind: "worker", workerId: "w1" }, new Set(), crew)).toBe(true);
    expect(stageReady({ id: "a", name: "A", kind: "worker", workerId: "gone" }, new Set(), crew)).toBe(false);
    expect(stageReady({ id: "a", name: "A", kind: "worker", workerId: "w1" }, new Set())).toBe(false);
  });

  it("says what each kind still needs", () => {
    expect(stageMissing(newStage("team"))).toBe("pick a team");
    expect(stageMissing(newStage("worker"))).toBe("pick a worker");
    expect(stageMissing(newStage("people"))).toBe("say who decides");
  });

  it("counts a worker stage as somewhere send back can land", () => {
    const stages: ProcessStage[] = [
      { id: "a", name: "Draft", kind: "worker", workerId: "w1" },
      { id: "b", name: "Decide", kind: "people", approvers: [{ name: "You" }] },
    ];
    expect(sendBackName(stages, 1)).toBe("Draft");
  });

  it("offers starting a worker stage again", () => {
    expect(itemActions(item(), newStage("worker", "Draft"))).toMatchObject({ retry: true, approve: false });
  });
});

describe("who fits a stage", () => {
  it("keeps the words that say what it's about, keyed by stem", () => {
    const w = matchWords("The UX designer designs prototypes with the team");
    expect(w.get("design")).toBe("designer");
    expect(w.get("prototyp")).toBe("prototypes");
    expect(w.has("with")).toBe(false);
    expect(w.has("team")).toBe(false);
    expect(w.has("ux")).toBe(false);
    expect(matchWords(undefined).size).toBe(0);
  });

  const teams = teamOptions([
    { id: "t-design", name: "Acme design crew", purpose: "Research and prototypes for Acme apps", members: [{ role: "UX designer" }] },
    { id: "t-dev", name: "Acme platform engineering", members: [{ role: "Developer" }, { role: "Code reviewer" }] },
    { id: "t-docs", name: "Acme docs desk", purpose: "Help articles" },
  ]);

  it("says a team by its purpose, else its roles", () => {
    expect(teams.map((t) => t.about)).toEqual(["Research and prototypes for Acme apps", "Developer, Code reviewer", "Help articles"]);
  });

  it("says a worker by its tagline and marks a paused one", () => {
    const opts = workerOptions([
      { id: "w1", name: "Acme summariser", tagline: "Summarises research notes", enabled: true },
      { id: "w2", name: "Acme scout", enabled: false },
    ]);
    expect(opts[0]).toMatchObject({ about: "Summarises research notes", text: "Acme summariser Summarises research notes" });
    expect(opts[0].paused).toBeUndefined();
    expect(opts[1]).toMatchObject({ about: "", paused: true });
  });

  it("ranks by the words a stage shares, with the library's words and crew", () => {
    const lib = libraryStageFor("idea-to-launch", "proto")!;
    const text = stageMatchText({ name: "Prototype", ask: "Build a clickable prototype" }, lib);
    const ranked = rankDoers(teams, text);
    const design = ranked.find((r) => r.option.id === "t-design")!;
    expect(design.hits).toEqual(expect.arrayContaining(["prototype", "design", "research"]));
    expect(goodMatches(ranked).map((r) => r.option.id)).toEqual(["t-design"]);
  });

  it("needs two shared words for a good match, and keeps at most three", () => {
    const many = rankDoers(
      ["a", "b", "c", "d"].map((id) => ({ id, name: `Acme ${id}`, about: "", text: "billing invoices refunds" })),
      "billing invoices refunds",
    );
    expect(goodMatches(many)).toHaveLength(3);
    expect(goodMatches(rankDoers(teams, "help"))).toHaveLength(0);
  });

  it("lists good matches, then everyone else alphabetically; a search lists what it finds", () => {
    const ranked = rankDoers(teams, stageMatchText({ name: "Prototype" }, libraryStageFor("idea-to-launch", "proto")));
    expect(pickerSections(ranked, "").map((s) => [s.label, s.rows.map((r) => r.option.id)])).toEqual([
      ["Good matches for this stage", ["t-design"]],
      ["Everyone else", ["t-docs", "t-dev"]],
    ]);
    expect(pickerSections(ranked, "help").map((s) => [s.label, s.rows.map((r) => r.option.id)])).toEqual([["All", ["t-docs"]]]);
    expect(pickerSections(ranked, "nothing like it")).toEqual([]);
    expect(pickerSections(rankDoers(teams, ""), "")[0].label).toBe("All");
  });
});

describe("stage timing", () => {
  it("says a stage's wait and runs in words", () => {
    expect(timingText({})).toBe("");
    expect(timingText({ delayDays: 14, repeat: { everyDays: 7, times: 4 } })).toBe("2 weeks after the stage before · weekly, 4 times");
    expect(timingText({ delayDays: 1 })).toBe("1 day after the stage before");
    expect(timingText({ repeat: { everyDays: 30, times: 3 } })).toBe("every 30 days, 3 times");
  });

  it("round-trips a repeat through the Runs select, and offers one it doesn't list", () => {
    expect(repeatKey(undefined)).toBe("");
    expect(repeatFromKey("")).toBeUndefined();
    expect(repeatFromKey(repeatKey({ everyDays: 14, times: 6 }))).toEqual({ everyDays: 14, times: 6 });
    expect(repeatOptions().map((o) => o.value)).toEqual(["", "7x2", "7x3", "7x4", "7x6", "7x8", "14x3", "14x6", "30x3", "30x6"]);
    expect(repeatOptions({ everyDays: 5, times: 2 }).at(-1)).toEqual({ value: "5x2", label: "Every 5 days, 2 times" });
  });

  it("offers a wait the list doesn't have", () => {
    expect(delayOptions().map((o) => o.value)).toEqual([0, 1, 3, 7, 14, 30, 60, 90]);
    expect(delayOptions(21).at(-1)).toEqual({ value: 21, label: "21 days after" });
    expect(delayOptions(14)).toHaveLength(8);
  });

  it("offers Start now only on a waiting item, to whoever steers it", () => {
    const team = newStage("team", "Verify");
    expect(itemActions(item({ startsAt: 5 }), team).startNow).toBe(true);
    expect(itemActions(item(), team).startNow).toBe(false);
    expect(itemActions(item({ startsAt: 5, canSteer: false }), team).startNow).toBe(false);
  });
});

describe("ways in", () => {
  it("turns a schedule preset into a cadence", () => {
    expect(scheduleCadence("weekly", "09:30", 4)).toEqual({ kind: "daily", time: "09:30", days: [4] });
    expect(scheduleCadence("weekdays", "08:00")).toEqual({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] });
    expect(scheduleCadence("monthly", "09:05")).toEqual({ kind: "cron", expr: "5 9 1 * *" });
    expect(scheduleCadence("quarterly", "14:00")).toEqual({ kind: "cron", expr: "0 14 1 1,4,7,10 *" });
    expect(scheduleCadence("monthly", "")).toEqual({ kind: "cron", expr: "0 9 1 * *" });
  });

  it("reads a watch's arguments as a JSON object", () => {
    expect(parseWatchArgs("  ")).toEqual({});
    expect(parseWatchArgs('{ "jql": "project = ACME" }')).toEqual({ jql: "project = ACME" });
    expect(parseWatchArgs("[1]")).toBeNull();
    expect(parseWatchArgs("{ nope")).toBeNull();
  });
});

describe("the board", () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;

  it("counts what's in flight, waiting on you, stuck and done lately, with the typical time", () => {
    const stats = boardStats(
      [
        item({ id: "a", stageIndex: 0 }),
        item({ id: "b", stageIndex: 2, canDecide: true, yourTurn: true }),
        item({ id: "c", stageIndex: 2, blocked: "The tool timed out" }),
        item({ id: "d", status: "done", createdAt: now - 5 * DAY, finishedAt: now - 3 * DAY }),
        item({ id: "e", status: "done", createdAt: now - 10 * DAY, finishedAt: now - 7 * DAY }),
        item({ id: "f", status: "done", createdAt: now - 90 * DAY, finishedAt: now - 60 * DAY }),
        item({ id: "g", status: "stopped" }),
      ],
      now,
    );
    expect(stats).toEqual({ inFlight: 3, stages: 2, waiting: 1, stuck: 1, done30: 2, typicalMs: 2.5 * DAY });
    expect(boardStats([], now).typicalMs).toBeNull();
  });

  it("says a span of time briefly", () => {
    expect(durationWords(40 * 60_000)).toBe("40 min");
    expect(durationWords(5 * 3_600_000)).toBe("5 hours");
    expect(durationWords(2.5 * DAY)).toBe("2.5 days");
    expect(durationWords(DAY)).toBe("1 day");
  });

  it("filters the list by tab and by stage", () => {
    const items = [
      item({ id: "a", stageIndex: 0, updatedAt: 1 }),
      item({ id: "b", stageIndex: 1, canDecide: true, yourTurn: true, updatedAt: 3 }),
      item({ id: "c", stageIndex: 1, blocked: "x", updatedAt: 2 }),
      item({ id: "d", status: "done" }),
    ];
    expect(filterItems(items, "all").map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(filterItems(items, "you").map((i) => i.id)).toEqual(["b"]);
    expect(filterItems([...items, item({ id: "e", initiator: { name: "Pat" } })], "mine").map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(filterItems(items, "stuck").map((i) => i.id)).toEqual(["c"]);
    expect(filterItems(items, "all", 1).map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("draws an item's track: done, current (or stuck), ahead", () => {
    expect(itemTrack({ status: "active", stageIndex: 1 }, 3)).toEqual(["done", "now", "ahead"]);
    expect(itemTrack({ status: "active", stageIndex: 0, blocked: "x" }, 2)).toEqual(["stuck", "ahead"]);
    expect(itemTrack({ status: "done", stageIndex: 2 }, 3)).toEqual(["done", "done", "done"]);
  });

  it("says where an item came from", () => {
    expect(itemSource({ initiator: { name: "Sam" }, source: "slack" })).toBe("From Sam · via Slack");
    expect(itemSource({ initiator: { name: "You" }, source: "desktop" })).toBe("From You");
  });

  it("sums up the ways in", () => {
    expect(waysInSummary(null, false)).toBe("Comes in from this page");
    expect(waysInSummary({ schedules: [{}], watches: [{ server: "Tracker" }, { server: "Tracker" }] }, true)).toBe(
      "Comes in from this page · /idea in Slack · a watch on Tracker · a schedule",
    );
  });

  it("says what's happening now, by where it is", () => {
    const decide: ProcessStage = { id: "d", name: "Approve the fix", kind: "people", approvers: [{ name: "You" }], ask: "Is the fix tested?" };
    const work: ProcessStage = { id: "w", name: "Reproduce and fix", kind: "team", teamId: "t" };
    expect(nowCard(item({ canDecide: true }), decide, "You")).toMatchObject({ mode: "decide", headline: "Your call: Approve the fix?", detail: "Is the fix tested?" });
    expect(nowCard(item({ stageNote: "Planning" }), work, "Acme web builders")).toMatchObject({ mode: "work", headline: "Acme web builders is on it", detail: "Planning" });
    expect(nowCard(item({ startsAt: 9, stageNote: "Starts Thu" }), work, "x")).toMatchObject({ mode: "waiting", detail: "Starts Thu" });
    expect(nowCard(item({ blocked: "The tool timed out" }), work, "x")).toMatchObject({ mode: "stuck", detail: "The tool timed out" });
    expect(nowCard(item({ status: "done" }), undefined, "x").mode).toBe("done");
  });

  it("walks an item's journey with what each stage produced", () => {
    const stages: ProcessStage[] = [
      { id: "a", name: "Triage", kind: "worker", workerId: "w" },
      { id: "b", name: "Fix", kind: "team", teamId: "t" },
      { id: "c", name: "Confirm", kind: "worker", workerId: "w" },
    ];
    const art = (stageId: string, title: string, at: number) => ({ stageId, stageName: stageId, at, title, summary: "", files: [] });
    const j = itemJourney(item({ stageIndex: 1, artifacts: [art("a", "old", 1), art("a", "Severity 2", 2), art("c", "from before", 0)] }), stages);
    expect(j.map((s) => s.state)).toEqual(["done", "now", "ahead"]);
    expect(j[0].artifact?.title).toBe("Severity 2");
    expect(j[1].artifact).toBeUndefined();
    expect(j[2].artifact?.title).toBe("from before");
  });

  it("folds the editor's extra rows away while they're at their defaults", () => {
    expect(stageMoreAtDefaults({})).toBe(true);
    expect(stageMoreAtDefaults({ delayDays: 7 })).toBe(false);
    expect(stageMoreAtDefaults({ sendBackTo: "a" })).toBe(false);
  });
});

describe("the item page", () => {
  const H = 3_600_000;
  const T0 = new Date(2026, 9, 19, 16, 12).getTime();
  const stages: ProcessStage[] = [
    { id: "triage", name: "Triage", kind: "worker", workerId: "w1" },
    { id: "fix", name: "Reproduce and fix", kind: "team", teamId: "t1" },
    {
      id: "approve",
      name: "Approve the fix",
      kind: "people",
      approvers: [{ name: "Sam Ortiz" }, { name: "You" }, { name: "Dana Lee" }],
      needs: 2,
      sendBackTo: "fix",
    },
    { id: "verify", name: "Verify in production", kind: "worker", workerId: "w2", delayDays: 1 },
  ];
  const doer = (s: ProcessStage) => (s.kind === "team" ? "Acme web builders" : s.workerId === "w1" ? "Triage bot" : "Release warden");
  const history: ProcessItemView["history"] = [
    { at: T0, kind: "submitted", by: "You" },
    { at: T0, kind: "entered", stageId: "triage" },
    { at: T0 + 1 * H, kind: "finished", stageId: "triage", note: "Real bug." },
    { at: T0 + 1 * H, kind: "entered", stageId: "fix" },
    { at: T0 + 6 * H, kind: "finished", stageId: "fix" },
    { at: T0 + 6 * H, kind: "entered", stageId: "approve" },
    { at: T0 + 8 * H, kind: "sentBack", stageId: "fix", by: "Sam Ortiz", note: "Stream the rows instead." },
    { at: T0 + 8 * H, kind: "entered", stageId: "fix" },
    { at: T0 + 17 * H, kind: "finished", stageId: "fix" },
    { at: T0 + 17 * H, kind: "entered", stageId: "approve" },
    { at: T0 + 17.3 * H, kind: "approved", by: "Sam Ortiz", note: "1 of 2" },
  ];
  const now = T0 + 19 * H;
  const waiting = item({
    title: "Acme CSV export fails over 10k rows",
    stageIndex: 2,
    canDecide: true,
    yourTurn: true,
    history,
    votes: [{ by: "Sam Ortiz", at: T0 + 17.3 * H, note: "Streaming is the right call." }],
    artifacts: [
      { stageId: "triage", stageName: "Triage", at: T0 + 1 * H, title: "Triage", summary: "Real bug, high priority. Six accounts hit it.", files: [] },
      {
        stageId: "fix",
        stageName: "Reproduce and fix",
        at: T0 + 17 * H,
        taskId: "task-1",
        title: "Fix",
        summary: "Streams rows in batches. See https://git.acme.dev/acme/web/pull/412 for the change.",
        files: ["repro-steps.md", "load-test.txt"],
        branch: "fix/csv-export-streaming",
      },
    ],
  });

  it("times each stage from the history, with redos", () => {
    const t = stageTimes(waiting, stages, now);
    expect(t[0]).toMatchObject({ ms: 1 * H, visits: 1, redos: 0, running: false });
    expect(t[1]).toMatchObject({ ms: 14 * H, visits: 2, redos: 1 });
    expect(t[2]).toMatchObject({ ms: 4 * H, running: true });
    expect(t[3].visits).toBe(0);
    expect(shortSpan(14 * H)).toBe("14 h");
    expect(shortSpan(40 * 60_000)).toBe("40 min");
  });

  it("says each stage's card: done, waiting on you, and when the next starts", () => {
    const cards = stageCards(waiting, stages, doer, now);
    expect(cards.map((c) => c.state)).toEqual(["done", "done", "now", "next"]);
    expect(cards[1].status).toBe("Done · 14 h, 1 redo");
    expect(cards[1].who).toBe("Acme web builders · team");
    expect(cards[2]).toMatchObject({ status: "Waiting on you", mine: true, who: "Sam Ortiz, You, Dana Lee · 2 of 3" });
    expect(cards[3].status).toBe("A day after the stage before");
  });

  it("says a team stage waiting on its owner without contradicting itself", () => {
    const pack = item({ stageIndex: 1, ownerTurn: "pack", waitsOn: "Pat", stageNote: "Pack waiting on Pat’s sign-off", history: history.slice(0, 4) });
    expect(nowLine(pack, stages[1])).toBe("Waiting on Pat: sign off the pack");
    expect(stageCards(pack, stages, doer, now)[1]).toMatchObject({ status: "Waiting on Pat: sign off the pack", mine: false });
    const mine = { ...pack, yourTurn: true };
    expect(stageCards(mine, stages, doer, now)[1].mine).toBe(true);
    expect(nowLine(mine, stages[1])).toBe("Waiting on you: sign off the pack");
    expect(nextSteps(pack, stages, doer)[0]).toContain("Pat has to sign off the pack");
  });

  it("shows starts, repeats and stops on the track", () => {
    const later = item({ stageIndex: 3, startsAt: now + 1.2 * 86_400_000, history });
    expect(stageCards(later, stages, doer, now)[3].status).toBe("Starts tomorrow");
    const repeat: ProcessStage[] = [{ id: "r", name: "Check adoption", kind: "worker", workerId: "w1", repeat: { everyDays: 7, times: 4 } }];
    expect(stageCards(item({ runs: 1, stageNote: "Working" }), repeat, doer, now)[0].status).toBe("Run 2 of 4 · Working");
    const stopped = item({ stageIndex: 1, status: "stopped", history: [...history.slice(0, 4), { at: T0 + 2 * H, kind: "stopped", by: "Pat", note: "Not worth it." }] });
    expect(stageCards(stopped, stages, doer, now).map((c) => c.status)).toEqual(["Done · 1 h", "Stopped here", "Not reached", "Not reached"]);
    expect(stoppedInfo(stopped, stages)).toMatchObject({ by: "Pat", why: "Not worth it.", stage: "Reproduce and fix" });
  });

  it("lists the vote: who approved, who's waiting, and the rule", () => {
    const { rows, have, need } = voteRows(waiting, stages[2]);
    expect([have, need]).toEqual([1, 2]);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["Sam Ortiz", "approved"],
      ["You", "waiting"],
      ["Dana Lee", "waiting"],
    ]);
    expect(voteRows({ votes: [{ by: "Sam Ortiz", at: 1 }, { by: "You", at: 2 }] }, stages[2]).rows.find((r) => r.name === "Dana Lee")?.state).toBe("notNeeded");
    expect(voteRuleText({ approvers: [{ name: "A" }], needs: "any" })).toBe("");
    expect(voteRuleText({ approvers: [{ name: "A" }, { name: "B" }] })).toBe("any one");
    expect(voteRuleText({ approverGroups: [{ id: "g", name: "Eng leads" }], needs: 2 })).toBe("2 needed");
    expect(voteRuleText({ approvers: [{ name: "A" }, { name: "B" }], needs: "all" })).toBe("all 2");
    expect(callLine(waiting, stages[2], now)).toBe("Sam Ortiz, You, Dana Lee, 2 of 3. Sam Ortiz approved, so yours would settle it. Waiting 2 h.");
  });

  it("offers earlier stages to send back to, the stage's own choice first", () => {
    expect(sendBackChoices(stages, 2)).toEqual({ choices: [{ index: 0, name: "Triage" }, { index: 1, name: "Reproduce and fix" }], defaultIndex: 1 });
    const noChoice = stages.map((s) => ({ ...s, sendBackTo: undefined }));
    expect(sendBackChoices(noChoice, 2).defaultIndex).toBe(1);
  });

  it("says what happens next", () => {
    const next = nextSteps(waiting, stages, doer);
    expect(next[0]).toBe("Your approval settles it, and it moves on to Verify in production.");
    expect(next).toContain("Release warden does Verify in production, 1 day after the stage before.");
    expect(next[next.length - 1]).toBe("If Approve the fix sends it back, it reopens at Reproduce and fix.");
    expect(nextSteps(item({ status: "done" }), stages, doer)[0]).toMatch(/made it through/);
  });

  it("finds where it stands, its links and what was handed on", () => {
    expect(whereItStands(waiting)).toEqual({ from: "Reproduce and fix", text: waiting.artifacts[1].summary });
    expect(itemLinks(waiting)).toEqual({ prs: [{ url: "https://git.acme.dev/acme/web/pull/412", label: "PR #412" }], branches: ["fix/csv-export-streaming"] });
    expect(handedOnLines(waiting).map((h) => [h.stage, h.line])).toEqual([
      ["Triage", "Real bug, high priority."],
      ["Reproduce and fix", "Streams rows in batches."],
    ]);
    expect(whereItStands(item({ stageNote: "Planning" }))).toEqual({ from: null, text: "Planning" });
  });

  it("tells the journey with redos tagged and a Now line", () => {
    const rows = journeyRows(waiting, stages, "Waiting on you");
    const redo = rows.find((r) => r.tag === "Redo");
    expect(redo).toMatchObject({ title: "Sent back to Reproduce and fix by Sam Ortiz", detail: "Stream the rows instead.", tone: "redo" });
    expect(rows[rows.length - 1]).toMatchObject({ title: "Waiting on you", tag: "Now", at: null });
    expect(rows.find((r) => r.title === "Reproduce and fix finished" && r.artifact === 1)).toBeTruthy();
    const retried = journeyRows(item({ history: [{ at: 1, kind: "entered", stageId: "fix" }, { at: 2, kind: "retried", by: "You" }], status: "done" }), stages);
    expect(retried[1]).toMatchObject({ title: "Reproduce and fix started again by You", tag: "Redo" });
  });

  it("says who does what, how long each took, and the time split", () => {
    const crew = crewRows(waiting, stages, doer, now);
    expect(crew.map((c) => [c.badge, c.took])).toEqual([
      ["W", "1 h"],
      ["T", "14 h"],
      ["P", "4 h so far"],
      ["W", "next"],
    ]);
    const split = timeSplit(waiting, stages, now);
    expect(split.total).toBe(19 * H);
    expect(split.caption).toBe("19 h in all · Triage 1 h · Reproduce and fix 14 h, including one redo · Approve the fix 4 h so far");
  });

  it("gives a finished item's outcome: the last pack, then the ones before", () => {
    const done = { ...waiting, status: "done" as const };
    const out = outcomeView(done, stages, doer);
    expect(out.last?.artifact.stageId).toBe("fix");
    expect(out.earlier.map((r) => r.line)).toEqual(["Triage · Triage bot"]);
    expect(outcomeView(waiting, stages, doer).last?.line).toBe("Reproduce and fix · Acme web builders · 2 files");
    expect(outcomeView(item(), stages, doer)).toEqual({ last: null, earlier: [] });
  });

  it("says where it came from and when", () => {
    expect(itemOrigin({ source: "trigger", sourceUrl: "https://tracker.acme.dev/WEB-1", initiator: { name: "You" } })).toBe("from a watch on tracker.acme.dev");
    expect(itemOrigin({ source: "slack", initiator: { name: "Pat" } })).toBe("from Pat in Slack");
    expect(itemOrigin({ source: "desktop", initiator: { name: "You" } })).toBe("put in here");
    expect(startedWords(T0, T0 + 86_400_000)).toMatch(/^yesterday 4:12/);
    expect(firstLine("## Big title\nrest")).toBe("Big title");
    expect(firstSentence("One thing. Another.")).toBe("One thing.");
  });

  it("says the current stage's live line above what was last handed on", () => {
    expect(liveLine(item({ stageIndex: 1, stageNote: "Working" }), stages[1], doer)).toBe("Reproduce and fix · Acme web builders: Working");
    expect(liveLine(waiting, stages[2], doer)).toBe("Approve the fix · Waiting on you");
    expect(liveLine(item({ stageIndex: 1, ownerTurn: "plan", waitsOn: "Pat" }), stages[1], doer)).toBe("Reproduce and fix · Waiting on Pat: approve the plan");
  });

  it("counts waiting on you by whose turn it is", () => {
    const list = [item({ id: "a", yourTurn: true }), item({ id: "b", canDecide: true }), item({ id: "c" })];
    expect(boardStats(list).waiting).toBe(1);
    expect(filterItems(list, "you").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("the process page", () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  const now = 100 * DAY;
  const stages: ProcessStage[] = [
    { id: "t", name: "Triage", kind: "worker", workerId: "w1" },
    { id: "f", name: "Reproduce and fix", kind: "team", teamId: "t1" },
    { id: "a", name: "Approve the fix", kind: "people", approvers: [{ name: "You" }] },
    { id: "c", name: "Confirm with the reporter", kind: "worker", workerId: "w2" },
  ];
  const through = (id: string, start: number, spans: number[]): ProcessItemView => {
    let t = start;
    const history: ProcessItemView["history"] = [{ at: t, kind: "submitted" }];
    spans.forEach((ms, i) => {
      history.push({ at: t, kind: "entered", stageId: stages[i].id });
      t += ms;
    });
    history.push({ at: t, kind: "done" });
    return item({ id, status: "done", stageIndex: stages.length - 1, createdAt: start, finishedAt: t, updatedAt: t, history });
  };

  it("counts what the summary line and the filters say", () => {
    const list = [
      item({ id: "a", yourTurn: true }),
      item({ id: "b", blocked: "x", initiator: { name: "Pat" } }),
      item({ id: "c", status: "stopped", finishedAt: now - DAY }),
      item({ id: "d", status: "done", finishedAt: now - 40 * DAY }),
    ];
    expect(filterCounts(list)).toEqual({ all: 2, you: 1, stuck: 1, mine: 1 });
    expect(pageStats(list, now)).toEqual({ inFlight: 2, waiting: 1, stuck: 1, done30: 0, stopped30: 1 });
    expect(recentFinished(list, now).map((i) => i.id)).toEqual(["c"]);
  });

  it("says the quiet summary line and the ways in", () => {
    const stats = { inFlight: 0, waiting: 0, stuck: 0, done30: 0, stopped30: 1 };
    const ways = waysInPhrase({ watches: [{ server: "Tracker" }] }, false);
    expect(ways).toBe("Comes in from this page and a watch on Tracker");
    expect(quietSummary({ name: "You" }, stats, ways)).toEqual(["Owned by you", "Nothing in flight", "1 stopped this month", ways]);
    expect(waysInPhrase({ schedules: [{}, {}] }, true)).toBe("Comes in from this page, Slack and 2 schedules");
    expect(waysInShort({ watches: [{ server: "Tracker" }] }, true)).toBe("page · Tracker · Slack");
  });

  it("times each stage from items' history: the last time, then usually", () => {
    const one = [through("a", 0, [2 * 60_000, 4 * H, DAY, H])];
    const d1 = stageDurations(one, stages, now);
    expect(d1[1]).toEqual({ samples: 1, medianMs: 4 * H, lastMs: 4 * H });
    expect(stageTimeWords(d1[1])).toBe("took 4 h last time");
    const three = [...one, through("b", DAY, [60_000, 6 * H, 2 * DAY, H]), through("c", 2 * DAY, [60_000, 8 * H, 3 * DAY, H])];
    const d3 = stageDurations(three, stages, now);
    expect(stageTimeWords(d3[1])).toBe("usually 6 h");
    // A stage still running isn't a sample yet.
    const live = item({ history: [{ at: now - H, kind: "entered", stageId: "t" }] });
    expect(stageDurations([live], stages, now)[0].samples).toBe(0);
    expect(stageTimeWords(stageDurations([live], stages, now)[0])).toBe("");
  });

  it("says end to end and where the time goes only once enough made it through", () => {
    const two = [through("a", 0, [H, H, DAY, H]), through("b", 0, [H, H, 2 * DAY, H])];
    expect(endToEnd(two, stages, now)).toBeNull();
    expect(timeBars(two, stages, now)).toBeNull();
    const three = [...two, through("c", 0, [H, H, 3 * DAY, H])];
    expect(endToEnd(three, stages, now)).toEqual({ typicalMs: 2 * DAY + 3 * H, slowest: "Approve the fix" });
    const bars = timeBars(three, stages, now)!;
    expect(bars.map((b) => b.share)).toEqual([1 / 48, 1 / 48, 1, 1 / 48]);
  });

  it("says a finished item's outcome and track", () => {
    const stopped = item({
      status: "stopped",
      stageIndex: 1,
      history: [{ at: 5, kind: "stopped", by: "You", note: "Reopened the ticket. More later." }],
    });
    expect(outcomeLine(stopped, stages)).toBe("Stopped by you at Reproduce and fix: \u201cReopened the ticket.\u201d");
    expect(recentTrack(stopped, 4)).toEqual(["done", "stuck", "ahead", "ahead"]);
    const done = item({ status: "done", artifacts: [{ stageId: "c", stageName: "Confirm", at: 9, title: "x", summary: "Fixed in PR 409. The reporter confirmed.", files: [] }] });
    expect(outcomeLine(done, stages)).toBe("Fixed in PR 409.");
    expect(outcomeLine(item({ status: "done" }), stages)).toBe("Made it through every stage.");
  });

  it("says what each stage does from its own words, else the library's", () => {
    expect(stageSentence({ ...stages[0], ask: "Checks the report is real. Then more." })).toBe("Checks the report is real.");
    expect(stageSentence(stages[0])).toBe("");
  });
});

describe("the flow diagram", () => {
  const S = (over: Partial<ProcessStage> & Pick<ProcessStage, "id" | "kind">): ProcessStage => ({ name: over.id, ...over });

  it("draws only what the process defines", () => {
    const plan = flowPlan([S({ id: "a", kind: "team" }), S({ id: "b", kind: "worker" })]);
    expect(plan).toEqual({ loops: [], delays: [], above: 0, below: 0 });
  });

  it("loops each decision back to where its send back goes, below first, then above", () => {
    const stages = [
      S({ id: "t", kind: "worker" }),
      S({ id: "f", kind: "team" }),
      S({ id: "a", kind: "people" }),
      S({ id: "c", kind: "worker" }),
      S({ id: "v", kind: "people", sendBackTo: "f" }),
    ];
    const plan = flowPlan(stages);
    expect(plan.loops).toEqual([
      { kind: "sendBack", from: 2, to: 1, side: "below", level: 1, label: "sent back with what to change" },
      { kind: "sendBack", from: 4, to: 1, side: "above", level: 1, label: "sent back with what to change" },
    ]);
    expect(plan.above).toBe(1);
    expect(plan.below).toBe(1);
    expect(flowPadding(plan)).toEqual({ top: FLOW_EDGE + FLOW_LANE, bottom: FLOW_EDGE + FLOW_LANE });
  });

  it("stacks a third loop further out, and loops a repeat onto itself with a wait on its arrow", () => {
    const stages = [
      S({ id: "a", kind: "team", repeat: { everyDays: 7, times: 4 }, delayDays: 14 }),
      S({ id: "b", kind: "people" }),
      S({ id: "c", kind: "people" }),
      S({ id: "d", kind: "people", sendBackTo: "a" }),
    ];
    const plan = flowPlan(stages);
    expect(plan.loops.map((l) => [l.kind, l.from, l.to, l.side, l.level])).toEqual([
      ["repeat", 0, 0, "above", 1],
      ["sendBack", 1, 0, "below", 1],
      ["sendBack", 2, 0, "below", 2],
      ["sendBack", 3, 0, "above", 2],
    ]);
    expect(plan.loops[0].label).toBe("every 7 days \u00d7 4");
    expect(plan.delays).toEqual([{ index: 0, lines: ["waits", "2 weeks"] }]);
  });

  it("loops a first-stage decision onto itself", () => {
    expect(flowPlan([S({ id: "a", kind: "people" })]).loops[0]).toMatchObject({ from: 0, to: 0, side: "below", level: 1 });
  });

  it("draws arrows across each gap and loops out to their lanes from the cards' boxes", () => {
    const plan = flowPlan([S({ id: "f", kind: "team", delayDays: 3 }), S({ id: "a", kind: "people" })]);
    const rects = [
      { x: 0, y: 20, w: 100, h: 100 },
      { x: 150, y: 20, w: 200, h: 100 },
      { x: 400, y: 20, w: 200, h: 100 },
      { x: 650, y: 20, w: 100, h: 100 },
    ];
    const d = flowDrawing(plan, rects);
    expect(d.arrows).toEqual(["M 100 70 L 148 70", "M 350 70 L 398 70", "M 600 70 L 648 70"]);
    expect(d.loops).toHaveLength(1);
    const lane = 120 + FLOW_LANE;
    expect(d.loops[0].d).toBe(`M 540 120 L 540 ${lane} L 210 ${lane} L 210 122`);
    expect(d.loops[0]).toMatchObject({ lx: 375, ly: lane, side: "below" });
    expect(d.delays).toEqual([{ x: 125, y: 70, lines: ["waits", "3 days"] }]);
    // Scaled up, everything follows the cards.
    const wide = flowDrawing(plan, rects.map((r) => ({ ...r, x: r.x * 2, w: r.w * 2 })));
    expect(wide.arrows[0]).toBe("M 200 70 L 298 70");
    expect(flowDrawing(plan, [])).toEqual({ arrows: [], loops: [], delays: [] });
  });

  it("keeps a floor width so the box scrolls rather than squeezes", () => {
    expect(flowMinWidth(4)).toBeGreaterThan(flowMinWidth(3));
  });
});

describe("pictureEditorDraft", () => {
  it("keeps role hints apart, uses the about line as the purpose and makes you the decider", () => {
    const out = pictureEditorDraft({
      name: "Contract approval",
      about: "A request becomes a signed contract.",
      stages: [
        { id: "d1", name: "Legal review", kind: "team", suggestedRole: "Legal reviewer" },
        { id: "d2", name: "Approved?", kind: "people", approvers: [], sendBackTo: "d1", suggestedRole: "Finance lead" },
        { id: "d3", name: "Sign", kind: "people", approvers: [{ name: "Pat" }] },
      ],
    });
    expect(out.name).toBe("Contract approval");
    expect(out.purpose).toBe("A request becomes a signed contract.");
    expect(out.roles).toEqual({ d1: "Legal reviewer", d2: "Finance lead" });
    expect(out.stages[0]).toEqual({ id: "d1", name: "Legal review", kind: "team" });
    expect(out.stages[1]).toEqual({ id: "d2", name: "Approved?", kind: "people", approvers: [{ name: "You" }], sendBackTo: "d1" });
    expect(out.stages[2].approvers).toEqual([{ name: "Pat" }]);
  });
});
