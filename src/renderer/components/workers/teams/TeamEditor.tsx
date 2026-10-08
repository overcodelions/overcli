// Create or edit a team. One question first — what should it produce, and in
// which project — and the coordinator suggests the people: crew workers who
// fit, and hires for the rest. You review the team as rows (role, job, where
// each one comes from), adjust, and create it; planned hires are hired only
// then. Picking members by hand is the second way in, not a competing one.
//
// A team only commissions its members, so every member is a worker on the
// crew. Team hires join it on demand, with no shifts (`hireForTeam` in main).

import { useMemo, useState } from "react";

import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import {
  DEFAULT_TEAM_BUDGET_USD,
  DEFAULT_TEAM_CHECKPOINTS,
  TEAM_MAX_MEMBERS,
  describeTeamCheckpoints,
  roleFromJob,
  type TeamCheckpoints,
  type TeamMember,
  type TeamRosterDraft,
} from "@shared/flows/team";
import { sortRoster, workerTagline, type Worker } from "@shared/flows/worker";
import { WorkerAvatar } from "../WorkerAvatar";
import { ProjectSelect, projectName, useProjectOptions } from "./ProjectChoice";

const primaryBtn = "text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40";
const secondaryBtn =
  "text-xs px-3 py-1.5 rounded-md border border-card-strong text-ink hover:bg-card-strong disabled:opacity-40";
const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

/// Someone the team will hire when you create it.
interface PlannedHire {
  id: string;
  job: string;
  role: string;
  status: "planned" | "hiring" | "failed";
  error?: string;
}

const CHECKPOINTS: Array<{ key: keyof TeamCheckpoints; label: string; detail: string }> = [
  {
    key: "askFirst",
    label: "Answer the coordinator's questions first",
    detail: "It may ask a few questions before it plans, when the answers would change the plan.",
  },
  {
    key: "reviewBeforeChallenge",
    label: "Look at the draft before it's challenged",
    detail: "Pause before each challenge stage so you can read what's there.",
  },
  {
    key: "finalReview",
    label: "Final review before it's filed",
    detail: "Hold the finished pack for you instead of marking the task done.",
  },
];

export function TeamEditor() {
  const editor = useTeamsStore((s) => s.editor);
  const teams = useTeamsStore((s) => s.teams);
  const save = useTeamsStore((s) => s.save);
  const remove = useTeamsStore((s) => s.remove);
  const closeEditor = useTeamsStore((s) => s.closeEditor);
  const draftRoster = useTeamsStore((s) => s.draftRoster);
  const hireMember = useTeamsStore((s) => s.hireMember);
  const workers = useWorkersStore((s) => s.workers);
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  const projectOptions = useProjectOptions();
  const existing = editor?.teamId ? teams[editor.teamId] : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [purpose, setPurpose] = useState(existing?.purpose ?? "");
  const [projectPath, setProjectPath] = useState(existing?.projectPath ?? "");
  const [ownProjectOnly, setOwnProjectOnly] = useState(existing?.ownProjectOnly ?? false);
  const [piecesAskFirst, setPiecesAskFirst] = useState(existing?.piecesAskFirst ?? false);
  const [members, setMembers] = useState<TeamMember[]>(existing?.members ?? []);
  const [planned, setPlanned] = useState<PlannedHire[]>([]);
  const [budget, setBudget] = useState(String(existing?.budgetUSDPerTask ?? DEFAULT_TEAM_BUDGET_USD));
  const [checkpoints, setCheckpoints] = useState<TeamCheckpoints>(existing?.checkpoints ?? DEFAULT_TEAM_CHECKPOINTS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The describe card leads a new team; once there is a team to look at it
  // folds to a line, and comes back to reshape it.
  const [describing, setDescribing] = useState(!existing);
  const [brief, setBrief] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [hiringFor, setHiringFor] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onlyIn = ownProjectOnly && projectPath ? projectPath : "";
  const projectLabel = projectName(projectOptions, projectPath);
  const seatsLeft = TEAM_MAX_MEMBERS - members.length - planned.length;
  const hiring = planned.some((h) => h.status === "hiring");
  const started = !!existing || members.length > 0 || planned.length > 0 || !describing;
  const crewToAdd = useMemo(
    () =>
      sortRoster(Object.values(workers)).filter(
        (w) => !members.some((m) => m.workerId === w.id) && (!onlyIn || w.projectPath === onlyIn),
      ),
    [workers, members, onlyIn],
  );
  const hiddenElsewhere = onlyIn
    ? Object.values(workers).filter((w) => w.projectPath !== onlyIn && !members.some((m) => m.workerId === w.id)).length
    : 0;

  const suggest = async () => {
    setDrafting(true);
    setError(null);
    const res = await draftRoster(brief, {
      name,
      purpose,
      // Reshaping keeps the team in view; a new team starts from the brief alone.
      members: existing ? members : [],
      ...(projectPath ? { projectPath } : {}),
      ...(onlyIn ? { ownProjectOnly: true } : {}),
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    setDrafting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    apply(res.draft);
  };

  /// The suggestion becomes the team on screen: you review it there.
  const apply = (draft: TeamRosterDraft) => {
    if (!existing || !name.trim()) setName(draft.name || name);
    if (!existing || !purpose.trim()) setPurpose(draft.purpose || purpose);
    if (!projectPath && draft.projectPath) setProjectPath(draft.projectPath);
    const crew = draft.members.flatMap((p) => (p.kind === "worker" ? [{ workerId: p.workerId, role: p.role }] : []));
    const hires = draft.members.flatMap((p) =>
      p.kind === "hire" ? [{ id: crypto.randomUUID(), job: p.job, role: p.role, status: "planned" as const }] : [],
    );
    setMembers(crew.slice(0, TEAM_MAX_MEMBERS));
    setPlanned(hires.slice(0, Math.max(0, TEAM_MAX_MEMBERS - crew.length)));
    setNote(draft.note || null);
    setDescribing(false);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    let team = members;
    const todo = planned.filter((h) => h.status !== "hiring");
    if (todo.length > 0) {
      setPlanned((prev) => prev.map((h) => (todo.some((t) => t.id === h.id) ? { ...h, status: "hiring", error: undefined } : h)));
      const results = await Promise.all(
        todo.map((h) =>
          hireMember({
            job: h.job,
            role: h.role,
            teamName: name.trim() || "New team",
            teamId: existing?.id,
            purpose: purpose.trim() || undefined,
            // A hire for this team lands in the team's project.
            ...(projectPath ? { projectPath, projectName: projectLabel } : {}),
          })
            .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
            .then((res) => ({ hire: h, res })),
        ),
      );
      // Whoever was hired is on the crew now: they join the team whatever
      // happens to the others, so a retry never hires them twice.
      const hired = results.flatMap(({ hire, res }) => (res.ok ? [{ workerId: res.worker.id, role: hire.role }] : []));
      team = [...members, ...hired];
      setMembers(team);
      setPlanned((prev) =>
        prev.flatMap((h) => {
          const r = results.find((x) => x.hire.id === h.id);
          if (!r) return [h];
          return r.res.ok ? [] : [{ ...h, status: "failed" as const, error: r.res.error }];
        }),
      );
      const failed = results.filter((r) => !r.res.ok).length;
      if (failed > 0) {
        setSaving(false);
        setError(`${failed} hire${failed === 1 ? "" : "s"} didn't go through — retry, or remove ${failed === 1 ? "it" : "them"}.`);
        return;
      }
    }
    const res = await save({
      id: existing?.id,
      name,
      purpose,
      ...(projectPath ? { projectPath } : {}),
      ...(onlyIn ? { ownProjectOnly: true } : {}),
      ...(piecesAskFirst ? { piecesAskFirst: true } : {}),
      members: team,
      budgetUSDPerTask: Number(budget),
      checkpoints,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    closeEditor();
    selectTeam(res.team.id);
  };

  const del = async () => {
    if (!existing) return;
    if (!window.confirm(`Delete the ${existing.name} team and its past tasks? The workers stay on the crew.`)) return;
    const res = await remove(existing.id);
    if (!res.ok) setError(res.error);
    else closeEditor();
  };

  const toHire = planned.length;
  const cta = toHire > 0 ? `Hire ${toHire} and ${existing ? "save" : "create team"}` : existing ? "Save team" : "Create team";
  const total = members.length + planned.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6">
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-1.5">
            <div className="text-xs text-ink-faint">Workers / {existing ? existing.name : "New team"}</div>
            {started ? (
              <>
                <label htmlFor="team-name" className="sr-only">
                  Team name
                </label>
                <input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name the team"
                  className="max-w-2xl border-b border-dashed border-card-strong bg-transparent py-0.5 text-2xl font-semibold tracking-tight text-ink outline-none placeholder:font-normal placeholder:italic placeholder:text-ink-faint focus:border-accent"
                />
                <label htmlFor="team-purpose" className="sr-only">
                  What it's for
                </label>
                <input
                  id="team-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="What it's for, in one line"
                  className="max-w-3xl border-b border-dashed border-card bg-transparent py-0.5 text-sm text-ink-muted outline-none placeholder:italic placeholder:text-ink-faint focus:border-accent"
                />
              </>
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight text-ink">New team</h1>
            )}
          </header>

          {describing ? (
            <section className="flex flex-col gap-4 rounded-xl border border-card-strong bg-surface-elevated p-5">
              <h2 className="text-base font-semibold text-ink">
                {existing ? "Reshape the team" : "What should this team produce?"}
              </h2>
              <WorksIn
                projectPath={projectPath}
                onProject={setProjectPath}
                ownProjectOnly={ownProjectOnly}
                onOwnProjectOnly={setOwnProjectOnly}
              />
              <label htmlFor="team-brief" className="sr-only">
                Describe the team
              </label>
              <textarea
                id="team-brief"
                rows={3}
                value={brief}
                autoFocus
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && brief.trim() && !drafting) void suggest();
                }}
                placeholder="e.g. A release team: check the candidate is ready, prep the website and release notes, cut the release and update the site."
                className="field resize-y px-3.5 py-3 text-sm leading-relaxed"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-ink-muted">
                  The coordinator picks people from your crew and suggests hires for the rest. Nothing is hired until
                  you say so.
                </span>
                <span className="flex items-center gap-2">
                  {started && (
                    <button className={quietBtn} onClick={() => setDescribing(false)}>
                      Never mind
                    </button>
                  )}
                  <button className={primaryBtn} disabled={drafting || !brief.trim()} onClick={() => void suggest()}>
                    {drafting ? "Thinking…" : existing ? "Suggest changes" : "Suggest a team"}
                  </button>
                </span>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <WorksIn
                compact
                projectPath={projectPath}
                onProject={setProjectPath}
                ownProjectOnly={ownProjectOnly}
                onOwnProjectOnly={setOwnProjectOnly}
              />
              <button className="text-xs text-accent hover:underline" onClick={() => setDescribing(true)}>
                {brief ? "Edit what you asked for" : "Describe it and get a suggestion"}
              </button>
            </div>
          )}

          {!started && (
            <button
              onClick={() => {
                setDescribing(false);
                setPicking(true);
              }}
              className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-card-strong px-4 py-3.5 text-left hover:bg-card-strong/40"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-ink">Or pick members yourself</span>
                <span className="text-xs text-ink-muted">
                  {crewToAdd.length} on your crew{onlyIn ? ` in ${projectLabel}` : ""} · you can hire for a role too
                </span>
              </span>
              <span aria-hidden className="text-ink-faint">
                ›
              </span>
            </button>
          )}

          {started && (
            <section className="flex flex-col overflow-hidden rounded-xl border border-card-strong bg-surface-elevated">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-card px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                  Members · {total}
                  {toHire > 0 && <span className="font-normal text-ink-muted"> · {toHire} to hire</span>}
                </h2>
                {note && <span className="max-w-3xl text-xs text-ink-muted">{note}</span>}
              </div>

              {total === 0 && <p className="px-4 py-4 text-xs text-ink-muted">No members yet. Add people from your crew, or hire for a role.</p>}

              <ul className="flex flex-col divide-y divide-card">
                {members.map((m) => {
                  const w = workers[m.workerId];
                  return (
                    <MemberRow
                      key={m.workerId}
                      rowId={m.workerId}
                      worker={w}
                      role={m.role}
                      tag={w ? memberTag(w, projectPath, projectLabel, projectOptions) : { text: "No longer on the crew", tone: "warn" }}
                      onRole={(role) => setMembers((prev) => prev.map((x) => (x.workerId === m.workerId ? { ...x, role } : x)))}
                      onRemove={() => setMembers((prev) => prev.filter((x) => x.workerId !== m.workerId))}
                    />
                  );
                })}
                {planned.map((h) => (
                  <MemberRow
                    key={h.id}
                    rowId={h.id}
                    role={h.role}
                    job={h.job}
                    tag={
                      h.status === "hiring"
                        ? { text: "Hiring — drafting their job and flow…", tone: "accent" }
                        : h.status === "failed"
                          ? { text: `Couldn't hire: ${h.error ?? "unknown error"}`, tone: "warn" }
                          : { text: `New hire · joins ${projectPath ? projectLabel : "the crew"} on demand`, tone: "accent" }
                    }
                    busy={h.status === "hiring"}
                    onRole={(role) => setPlanned((prev) => prev.map((x) => (x.id === h.id ? { ...x, role } : x)))}
                    onJob={(job) => setPlanned((prev) => prev.map((x) => (x.id === h.id ? { ...x, job } : x)))}
                    onRemove={() => setPlanned((prev) => prev.filter((x) => x.id !== h.id))}
                  />
                ))}
              </ul>

              {picking && (
                <CrewPicker
                  crew={crewToAdd}
                  full={seatsLeft <= 0}
                  hidden={hiddenElsewhere}
                  projectPath={projectPath}
                  onAdd={(w) => setMembers((prev) => (prev.length + planned.length >= TEAM_MAX_MEMBERS ? prev : [...prev, { workerId: w.id, role: "" }]))}
                  onClose={() => setPicking(false)}
                />
              )}
              {hiringFor && (
                <HireForm
                  onCancel={() => setHiringFor(false)}
                  onAdd={(job) => {
                    setPlanned((prev) => [...prev, { id: crypto.randomUUID(), job, role: roleFromJob(job), status: "planned" }]);
                    setHiringFor(false);
                  }}
                />
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-card bg-card/40 px-4 py-2.5">
                <button className={secondaryBtn} disabled={seatsLeft <= 0 || picking} onClick={() => setPicking(true)}>
                  Add from crew
                </button>
                <button
                  className="text-xs px-3 py-1.5 rounded-md border border-dashed border-accent/60 text-accent hover:bg-accent/10 disabled:opacity-40"
                  disabled={seatsLeft <= 0 || hiringFor}
                  onClick={() => setHiringFor(true)}
                >
                  + Hire for a role
                </button>
                {seatsLeft <= 0 && <span className="text-[11px] text-ink-faint">A team can have at most {TEAM_MAX_MEMBERS} members.</span>}
                {brief.trim() && (
                  <button className={quietBtn + " ml-auto"} disabled={drafting} onClick={() => void suggest()}>
                    {drafting ? "Thinking…" : "Suggest again"}
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-3 rounded-xl bg-card/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-muted">
              <b className="font-semibold text-ink">Each task</b>
              <span>
                Up to <b className="font-semibold text-ink">${Number(budget) || 0}</b>
              </span>
              {describeTeamCheckpoints(checkpoints).map((c) => (
                <span key={c}>{c}</span>
              ))}
              <span className={piecesAskFirst ? "" : "text-ink"}>
                {piecesAskFirst ? "members keep their own permissions" : "members work without asking"}
              </span>
              <span className="text-ink-faint">· a coordinator plans the stages and writes the pack</span>
              <button className="ml-auto text-xs text-accent hover:underline" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
                {settingsOpen ? "Done" : "Change"}
              </button>
            </div>
            {settingsOpen && (
              <div className="flex max-w-xl flex-col divide-y divide-card rounded-lg border border-card bg-surface-elevated">
                <label className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm text-ink">
                  Budget per task
                  <span className="flex items-center gap-1 text-ink-muted">
                    $
                    <input
                      value={budget}
                      onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
                      inputMode="decimal"
                      className="field w-16 px-2 py-1 text-right text-sm"
                    />
                  </span>
                </label>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm text-ink">
                  <span>
                    Approve the plan <span className="text-[11px] text-ink-faint">· always</span>
                  </span>
                  <Switch on disabled label="Approve the plan" onChange={() => {}} />
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="flex flex-col">
                    <span className="text-sm text-ink">Members work without asking</span>
                    <span className="text-[11px] leading-relaxed text-ink-faint">
                      A piece the team commissions may use any tool and act outside its folder — push, post, call a
                      service — whatever the member's own settings say. Their own shifts and errands are unchanged.
                      Off: each member's own permissions, and anything outside a piece's tools is refused.
                    </span>
                  </span>
                  <Switch on={!piecesAskFirst} label="Members work without asking" onChange={(on) => setPiecesAskFirst(!on)} />
                </div>
                {CHECKPOINTS.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3 px-3 py-2.5" title={c.detail}>
                    <span className="text-sm text-ink">{c.label}</span>
                    <Switch
                      on={checkpoints[c.key]}
                      label={c.label}
                      onChange={(on) => setCheckpoints((prev) => ({ ...prev, [c.key]: on }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-card bg-surface-elevated px-6 py-3">
        <span className="text-xs text-ink-muted">
          {total === 0 ? "No members yet" : `${total} member${total === 1 ? "" : "s"}`}
          {toHire > 0 && ` · ${toHire} to hire`}
          {Number(budget) > 0 && ` · up to $${Number(budget)} per task`}
        </span>
        <span className="flex items-center gap-2">
          {error && <span className="text-xs text-red-500">{error}</span>}
          {existing && (
            <button onClick={del} className="text-xs px-3 py-1.5 rounded-md text-red-500 hover:bg-red-500/10">
              Delete team
            </button>
          )}
          <button onClick={closeEditor} className={secondaryBtn}>
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving || hiring || total === 0}
            title={hiring ? "Hiring — the team is saved once they join the crew" : undefined}
            className={primaryBtn}
          >
            {hiring ? "Hiring…" : cta}
          </button>
        </span>
      </footer>
    </div>
  );
}

/// Where the team works, and whether only that project's workers belong.
function WorksIn({
  projectPath,
  onProject,
  ownProjectOnly,
  onOwnProjectOnly,
  compact = false,
}: {
  projectPath: string;
  onProject: (path: string) => void;
  ownProjectOnly: boolean;
  onOwnProjectOnly: (on: boolean) => void;
  compact?: boolean;
}) {
  const options = useProjectOptions();
  const label = projectName(options, projectPath);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="flex items-center gap-2">
        <label htmlFor="team-project" className="text-xs text-ink-muted">
          Works in
        </label>
        <ProjectSelect
          id="team-project"
          value={projectPath}
          onChange={onProject}
          noneLabel="Each member's own project"
          className={
            compact
              ? "cursor-pointer rounded-full bg-card-strong px-2.5 py-1 text-xs text-ink focus:outline-none"
              : "field min-w-[240px] px-2.5 py-1.5 text-sm"
          }
        />
      </span>
      {projectPath ? (
        <label className="flex items-center gap-2 text-xs text-ink-muted" title="Suggestions use only its workers and hire for the rest; workers from other projects aren't offered.">
          <input
            type="checkbox"
            checked={ownProjectOnly}
            onChange={(e) => onOwnProjectOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--c-accent)]"
          />
          Only members from {label}
        </label>
      ) : (
        !compact && (
          <span className="text-[11px] text-ink-faint">A team that changes code or ships something should work in that project.</span>
        )
      )}
    </div>
  );
}

type Tone = "accent" | "warn" | "muted";

/// Where a member comes from, against the team's project.
function memberTag(
  w: Worker,
  projectPath: string,
  projectLabel: string | undefined,
  options: ReturnType<typeof useProjectOptions>,
): { text: string; tone: Tone } {
  if (!w.enabled) return { text: "Paused — resume them before briefing the team", tone: "warn" };
  if (projectPath && w.projectPath !== projectPath) {
    return { text: `Borrowed · usually works in ${projectName(options, w.projectPath)}`, tone: "warn" };
  }
  const parts = [w.heartbeatBackend, w.hiredFor && w.cadence === null ? "on demand" : null, projectPath ? `in ${projectLabel}` : null];
  return { text: parts.filter(Boolean).join(" · ") || workerTagline(w), tone: "muted" };
}

const TONE: Record<Tone, string> = {
  accent: "text-accent",
  warn: "text-amber-500",
  muted: "text-ink-faint",
};

function MemberRow({
  rowId,
  worker,
  role,
  job,
  tag,
  busy = false,
  onRole,
  onJob,
  onRemove,
}: {
  /// Unique on the page: ties each row's labels to its fields.
  rowId: string;
  worker?: Worker;
  role: string;
  /// A planned hire's job, editable until they are hired.
  job?: string;
  tag: { text: string; tone: Tone };
  busy?: boolean;
  onRole: (role: string) => void;
  onJob?: (job: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[32px_minmax(0,220px)_minmax(0,1fr)_auto]">
      {worker ? (
        <WorkerAvatar worker={worker} size="md" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-accent/70 text-accent">
          {busy ? <span className="h-3 w-3 animate-spin rounded-full border border-ink-faint/40 border-t-accent" /> : "+"}
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5 pt-0.5">
        <span className="truncate text-sm font-medium text-ink">{worker ? worker.name : "New hire"}</span>
        <span className={"text-[11px] leading-snug " + TONE[tag.tone]}>{tag.text}</span>
      </span>
      <span className="col-start-2 flex min-w-0 flex-col gap-1.5 md:col-start-auto">
        <label className="sr-only" htmlFor={`role-${rowId}`}>
          Role on this team
        </label>
        <input
          id={`role-${rowId}`}
          value={role}
          disabled={busy}
          onChange={(e) => onRole(e.target.value)}
          placeholder={worker && workerTagline(worker) ? `Role — defaults to: ${workerTagline(worker)}` : "Role on this team"}
          className="field px-2.5 py-1.5 text-xs"
        />
        {job !== undefined && onJob && (
          <>
            <label className="sr-only" htmlFor={`job-${rowId}`}>
              The job to hire for
            </label>
            <textarea
              id={`job-${rowId}`}
              rows={2}
              value={job}
              disabled={busy}
              onChange={(e) => onJob(e.target.value)}
              className="field resize-y px-2.5 py-1.5 text-xs leading-relaxed text-ink-muted"
            />
          </>
        )}
      </span>
      <button
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${worker?.name ?? "this hire"} from the team`}
        className="col-start-2 justify-self-start rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-card-strong hover:text-ink disabled:opacity-40 md:col-start-auto md:justify-self-end"
      >
        Remove
      </button>
    </li>
  );
}

function CrewPicker({
  crew,
  full,
  hidden,
  projectPath,
  onAdd,
  onClose,
}: {
  crew: Worker[];
  full: boolean;
  /// Workers left out because the team takes only its project's.
  hidden: number;
  projectPath: string;
  onAdd: (w: Worker) => void;
  onClose: () => void;
}) {
  const options = useProjectOptions();
  return (
    <div className="flex flex-col gap-2 border-t border-card bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">Your crew</span>
        <button className={quietBtn} onClick={onClose}>
          Done
        </button>
      </div>
      {crew.length === 0 && <p className="text-xs text-ink-muted">Everyone who fits is already on the team. Hire for a role instead.</p>}
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {crew.map((w) => (
          <div key={w.id} className="flex items-center gap-2.5 rounded-lg border border-card px-2.5 py-2">
            <WorkerAvatar worker={w} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-medium text-ink">
                {w.name}
                {!w.enabled && <span className="ml-1.5 text-[10px] text-amber-500">paused</span>}
              </span>
              <span className="truncate text-[11px] text-ink-faint">
                {projectPath && w.projectPath !== projectPath ? `from ${projectName(options, w.projectPath)} · ` : ""}
                {workerTagline(w)}
              </span>
            </span>
            <button className={secondaryBtn} disabled={full} onClick={() => onAdd(w)}>
              Add
            </button>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <span className="text-[11px] text-ink-faint">
          {hidden} from other projects not shown — this team takes only its own project's workers.
        </span>
      )}
    </div>
  );
}

function HireForm({ onAdd, onCancel }: { onAdd: (job: string) => void; onCancel: () => void }) {
  const [job, setJob] = useState("");
  const add = () => job.trim() && onAdd(job.trim());
  return (
    <div className="flex flex-col gap-2 border-t border-card bg-surface px-4 py-3">
      <label htmlFor="hire-job" className="text-xs font-medium text-ink">
        What should they do on this team?
      </label>
      <textarea
        id="hire-job"
        rows={2}
        autoFocus
        value={job}
        onChange={(e) => setJob(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="e.g. Challenger: runs the build and tests on the candidate and blocks anything not ready to ship."
        className="field resize-y px-2.5 py-1.5 text-xs leading-relaxed"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-faint">Hired when you create the team · joins on demand, no shifts.</span>
        <span className="flex gap-2">
          <button className={quietBtn} onClick={onCancel}>
            Cancel
          </button>
          <button className={primaryBtn} disabled={!job.trim()} onClick={add}>
            Add to team
          </button>
        </span>
      </div>
    </div>
  );
}

export function Switch({
  on,
  label,
  onChange,
  disabled = false,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={
        "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50 " +
        (on ? "justify-end bg-accent" : "justify-start bg-card-strong")
      }
    >
      <span className="h-4 w-4 rounded-full bg-white shadow" />
    </button>
  );
}
