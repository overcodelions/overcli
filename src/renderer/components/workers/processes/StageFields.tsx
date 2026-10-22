// What a people stage asks for: the editor that sets its fields up, and the
// form the people at it fill in. What they put becomes the stage's artifact,
// handed on to every stage after (see shared/org/process.ts).

import type { ProcessField, ProcessFieldKind, ProcessStage } from "@shared/org/process";

const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

const KIND_WORDS: Record<ProcessFieldKind, string> = { text: "Short answer", longText: "Long answer", choice: "Pick one" };

/// A new field's id: the first `fN` not taken.
function nextId(fields: readonly ProcessField[]): string {
  let n = fields.length + 1;
  while (fields.some((f) => f.id === `f${n}`)) n++;
  return `f${n}`;
}

/// The stage's mode and fields, as the editor sets them.
export function StageAsksEditor({ stage, onChange }: { stage: ProcessStage; onChange: (patch: Pick<ProcessStage, "mode" | "fields">) => void }) {
  const fields = stage.fields ?? [];
  const input = stage.mode === "input";
  const set = (next: ProcessField[]) => onChange({ fields: next.length ? next : undefined, mode: next.length ? stage.mode : undefined });
  const put = (n: number, patch: Partial<ProcessField>) => set(fields.map((f, k) => (k === n ? { ...f, ...patch } : f)));
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div role="group" aria-label="What people do here" className="flex flex-wrap gap-1.5">
        {[
          { mode: undefined, label: "Decide" },
          { mode: "input" as const, label: "Fill in only" },
        ].map((m) => (
          <button
            key={m.label}
            type="button"
            aria-pressed={input === (m.mode === "input")}
            onClick={() => onChange({ mode: m.mode, fields: m.mode === "input" && !fields.length ? [{ id: "f1", label: "", kind: "text", required: true }] : stage.fields })}
            className={
              "rounded-lg border px-3 py-1 text-xs font-semibold " +
              (input === (m.mode === "input") ? "border-amber-400 bg-amber-400/15 text-amber-700 dark:text-amber-300" : "border-card-strong text-ink-muted hover:text-ink")
            }
          >
            {m.label}
          </button>
        ))}
      </div>
      {fields.map((f, n) => (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5">
          <input
            aria-label={`Question ${n + 1}`}
            value={f.label}
            onChange={(e) => put(n, { label: e.target.value })}
            placeholder="e.g. Budget for this"
            className="field w-[220px] px-2 py-1 text-xs"
          />
          <select aria-label={`Kind of answer for question ${n + 1}`} value={f.kind} onChange={(e) => put(n, { kind: e.target.value as ProcessFieldKind })} className="field w-auto px-2 py-1 text-xs">
            {(Object.keys(KIND_WORDS) as ProcessFieldKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k]}
              </option>
            ))}
          </select>
          {f.kind === "choice" && (
            <input
              aria-label={`Choices for question ${n + 1}`}
              defaultValue={(f.options ?? []).join(", ")}
              onBlur={(e) => put(n, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
              placeholder="Choices, comma-separated"
              className="field w-[200px] px-2 py-1 text-xs"
            />
          )}
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <input type="checkbox" checked={!!f.required} onChange={(e) => put(n, { required: e.target.checked || undefined })} />
            Required
          </label>
          <button type="button" className={quietBtn} aria-label={`Remove question ${n + 1}`} onClick={() => set(fields.filter((_, k) => k !== n))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className={quietBtn + " self-start"} disabled={fields.length >= 12} onClick={() => set([...fields, { id: nextId(fields), label: "", kind: "text" }])}>
        + Ask for something
      </button>
    </div>
  );
}

/// The stage's fields, to fill in before approving or submitting.
export function StageForm({ fields, answers, onChange }: { fields: readonly ProcessField[]; answers: Record<string, string>; onChange: (answers: Record<string, string>) => void }) {
  const set = (id: string, v: string) => onChange({ ...answers, [id]: v });
  return (
    <div className="flex flex-col gap-2.5 border-t border-amber-400/25 pt-3">
      {fields.map((f) => (
        <label key={f.id} className="flex flex-col gap-1 text-[12.5px] text-ink-muted">
          <span>
            {f.label}
            {f.required ? "" : " (optional)"}
          </span>
          {f.kind === "choice" ? (
            <select value={answers[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} className="field w-auto max-w-[320px] px-2 py-1.5 text-[13px]">
              <option value="">Pick one</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.kind === "longText" ? (
            <textarea rows={3} value={answers[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} className="field max-w-xl resize-y px-2.5 py-2 text-[13px] leading-relaxed" />
          ) : (
            <input value={answers[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} className="field max-w-md px-2.5 py-1.5 text-[13px]" />
          )}
        </label>
      ))}
    </div>
  );
}

/// The required fields still empty, by label.
export function missingAnswers(fields: readonly ProcessField[] | undefined, answers: Record<string, string>): string[] {
  return (fields ?? []).filter((f) => f.required && !answers[f.id]?.trim()).map((f) => f.label);
}
