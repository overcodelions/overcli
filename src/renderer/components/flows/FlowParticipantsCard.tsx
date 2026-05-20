// Participants section of the flow editor. Lets the user declare the
// "cast" of the flow up front — Primary (premium planner/reviewer),
// Worker (local implementer), etc. — and gives steps an explicit
// participant picker. Without this card the editor still works (the
// per-step model picker auto-synthesizes participants), but listing
// them at the top of the flow makes the design intent visible and
// makes it easy to swap a model in one place without editing every
// step.

import { useEffect, useState } from 'react';

import type { Backend } from '@shared/types';
import type { FlowParticipant } from '@shared/flows/schema';
import { useFlowsStore } from '../../flowsStore';
import { PREMIUM_MODELS as BACKEND_MODELS, friendlyModelLabel } from '@shared/modelCatalog';

const BACKENDS: Backend[] = ['claude', 'codex', 'gemini', 'copilot', 'ollama'];

/// Per-kind background tint + left accent rail. Keeps the participant
/// list readable as a "cast" — primary stands out, worker reads
/// differently from reviewer, custom is neutral.
const KIND_STYLES: Record<
  NonNullable<FlowParticipant['kind']> | 'custom',
  { bg: string; rail: string }
> = {
  primary: { bg: 'bg-sky-500/[0.07]', rail: 'bg-sky-400/70' },
  worker: { bg: 'bg-emerald-500/[0.07]', rail: 'bg-emerald-400/70' },
  reviewer: { bg: 'bg-purple-500/[0.07]', rail: 'bg-purple-400/70' },
  custom: { bg: 'bg-card/35', rail: 'bg-card-strong' },
};

export function FlowParticipantsCard() {
  const draft = useFlowsStore((s) => s.editorDraft);
  const updateDraft = useFlowsStore((s) => s.updateDraft);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [detectStatus, setDetectStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  );

  // Count which participants are actually referenced by a step, so the
  // UI can surface orphan participants (created via per-step picker
  // cycling) and offer a one-click cleanup.
  const usageByParticipantId = (() => {
    const counts: Record<string, number> = {};
    for (const step of draft?.steps ?? []) {
      counts[step.participantId] = (counts[step.participantId] ?? 0) + 1;
    }
    return counts;
  })();
  const orphanCount = (draft?.participants ?? []).filter(
    (p) => !usageByParticipantId[p.id],
  ).length;

  async function refreshOllama() {
    setDetectStatus('loading');
    try {
      const r = await window.overcli.invoke('ollama:detect');
      setOllamaModels(r.models.map((m) => m.name));
      setDetectStatus('done');
    } catch {
      setDetectStatus('error');
    }
  }

  useEffect(() => {
    void refreshOllama();
  }, []);

  if (!draft) return null;
  const participants = draft.participants ?? [];

  function setAll(next: FlowParticipant[]) {
    updateDraft({ participants: next });
  }

  function patchAt(idx: number, patch: Partial<FlowParticipant>) {
    setAll(participants.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function add(kindHint?: FlowParticipant['kind']) {
    const baseId = kindHint ?? 'participant';
    let id = baseId;
    let n = 2;
    while (participants.some((p) => p.id === id)) id = `${baseId}-${n++}`;
    const defaultModel: { backend: Backend; model: string } =
      kindHint === 'worker'
        ? { backend: 'ollama', model: ollamaModels[0] ?? '' }
        : { backend: 'claude', model: 'claude-opus-4-7' };
    // Default name uses the kind label ("Primary", "Worker", …) when
    // one is set; otherwise mirror the model so the user sees the
    // role-or-model in one column instead of a generic "Participant".
    const defaultName =
      kindHint === 'primary'
        ? 'Primary'
        : kindHint === 'worker'
          ? 'Worker'
          : kindHint === 'reviewer'
            ? 'Reviewer'
            : friendlyModelLabel(defaultModel.backend, defaultModel.model);
    setAll([
      ...participants,
      {
        id,
        name: defaultName,
        backend: defaultModel.backend,
        model: defaultModel.model,
        kind: kindHint,
      },
    ]);
  }

  function remove(idx: number) {
    setAll(participants.filter((_, i) => i !== idx));
  }

  return (
    <div className="rounded-xl bg-card p-5 shadow-sm">
      <div className="flex items-center mb-3 flex-wrap gap-x-2">
        <div className="text-sm font-semibold">Participants</div>
        <span className="text-[11px] text-ink-faint">
          the models that take part in this flow — steps reference them by id
          {' · '}
          {detectStatus === 'loading'
            ? 'detecting local models…'
            : detectStatus === 'error'
              ? <span className="text-red-300">ollama detect failed</span>
              : `${ollamaModels.length} local model${ollamaModels.length === 1 ? '' : 's'}`}
          {' '}
          <button
            onClick={() => void refreshOllama()}
            className="text-ink-faint hover:text-ink underline-offset-2 hover:underline"
          >
            (refresh)
          </button>
        </span>
        {orphanCount > 0 && (
          <button
            onClick={() => {
              if (!draft) return;
              const kept = draft.participants.filter((p) => usageByParticipantId[p.id]);
              updateDraft({ participants: kept });
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-400/30 hover:bg-amber-500/25"
            title="Remove participants no step references"
          >
            Clean up {orphanCount} unused
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => add('primary')}
            disabled={participants.some((p) => p.kind === 'primary')}
            className="text-[11px] px-2 py-1 rounded bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 border border-sky-400/30 disabled:opacity-40"
            title="Add a Primary participant (premium planner/reviewer)"
          >
            + Primary
          </button>
          <button
            onClick={() => add('worker')}
            disabled={participants.some((p) => p.kind === 'worker')}
            className="text-[11px] px-2 py-1 rounded bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 border border-emerald-400/30 disabled:opacity-40"
            title="Add a Worker participant (local implementer)"
          >
            + Worker
          </button>
          <button
            onClick={() => add('reviewer')}
            disabled={participants.some((p) => p.kind === 'reviewer')}
            className="text-[11px] px-2 py-1 rounded bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 border border-purple-400/30 disabled:opacity-40"
            title="Add a Reviewer participant"
          >
            + Reviewer
          </button>
          <button
            onClick={() => add('custom')}
            className="text-[11px] px-2 py-1 rounded bg-card hover:bg-card-strong border border-card-strong"
            title="Add a custom participant"
          >
            + Custom
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {participants.map((p, i) => (
          <ParticipantRow
            key={p.id + ':' + i}
            participant={p}
            ollamaModels={ollamaModels}
            usageCount={usageByParticipantId[p.id] ?? 0}
            onPatch={(patch) => patchAt(i, patch)}
            onRemove={() => remove(i)}
          />
        ))}
        {participants.length === 0 && (
          <div className="text-[11px] text-ink-faint">
            No participants yet. Add a Primary (and optionally a Worker) to get started.
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantRow({
  participant,
  ollamaModels,
  usageCount,
  onPatch,
  onRemove,
}: {
  participant: FlowParticipant;
  ollamaModels: string[];
  usageCount: number;
  onPatch: (patch: Partial<FlowParticipant>) => void;
  onRemove: () => void;
}) {
  const modelChoices =
    participant.backend === 'ollama'
      ? ollamaModels
      : BACKEND_MODELS[participant.backend as Exclude<Backend, 'ollama'>] ?? [];
  // Cleaner display name — if the stored name is just the raw model id
  // (a stale auto-synth from before friendlyModelLabel was wired in),
  // show the friendly label instead so old flows read correctly. Only
  // affects the input's placeholder/value when stale; user edits still
  // win.
  const displayName = looksLikeRawModelId(participant.name, participant.model)
    ? friendlyModelLabel(participant.backend, participant.model)
    : participant.name;

  // Soft tint + left accent rail keyed to the participant's role. Reads
  // as a card group ("these are the people in the flow") instead of a
  // grid of hard-bordered form rows.
  const kindStyle = KIND_STYLES[participant.kind ?? 'custom'] ?? KIND_STYLES.custom;

  return (
    // One-line row. Name input flexes, dropdowns + badge + delete trail
    // off to the right. The id is shown as a small caption under the
    // name (read-mostly — users almost never need to edit it).
    <div
      className={
        'relative rounded-lg px-3 py-2 transition-colors ' +
        kindStyle.bg + ' hover:bg-card/55'
      }
    >
      <span
        aria-hidden
        className={'absolute left-0 top-2 bottom-2 w-[3px] rounded-full ' + kindStyle.rail}
      />
      <div className="grid grid-cols-[1fr_120px_1fr_72px_28px] gap-2 items-center pl-2">
        <input
          value={displayName}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="bg-card-strong rounded px-2 py-1.5 text-sm"
          placeholder="name (e.g. Primary, Surveyor, Worker)"
        />
        <select
          value={participant.backend}
          onChange={(e) =>
            onPatch({
              backend: e.target.value as Backend,
              model: '', // model space is backend-specific
            })
          }
          className="bg-card-strong rounded px-2 py-1.5 text-xs"
        >
          {BACKENDS.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        {modelChoices.length > 0 ? (
          <select
            value={participant.model}
            onChange={(e) => onPatch({ model: e.target.value })}
            className="bg-card-strong rounded px-2 py-1.5 text-xs font-mono"
          >
            <option value="">(pick model)</option>
            {modelChoices.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            value={participant.model}
            onChange={(e) => onPatch({ model: e.target.value })}
            className="bg-card-strong rounded px-2 py-1.5 text-xs font-mono"
            placeholder={participant.backend === 'ollama' ? 'no ollama models found' : ''}
          />
        )}
        <span
          className={
            'text-[10px] text-center px-1 py-0.5 rounded ' +
            (usageCount === 0
              ? 'bg-amber-500/15 text-amber-200 border border-amber-400/30'
              : 'text-ink-faint')
          }
          title={
            usageCount === 0
              ? 'No step references this participant. Safe to remove.'
              : `Used by ${usageCount} step${usageCount === 1 ? '' : 's'}.`
          }
        >
          {usageCount === 0 ? 'unused' : `${usageCount} step${usageCount === 1 ? '' : 's'}`}
        </span>
        <button
          onClick={onRemove}
          className="text-[11px] w-6 h-6 rounded text-red-300 hover:bg-red-500/20"
          title="Remove participant"
        >
          ×
        </button>
      </div>
      {/* Id caption — shown as a tiny mono pill, clickable to edit.
          Most users never need to touch this; flagging it as
          'optional' detail keeps the row uncluttered. */}
      <IdCaption
        id={participant.id}
        onChange={(next) => onPatch({ id: next })}
      />
    </div>
  );
}

/// Tiny "id: <slug>" caption with click-to-edit. Renders as a small
/// muted label by default; click swaps to an inline input that commits
/// on blur or Enter.
function IdCaption({ id, onChange }: { id: string; onChange: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);
  function commit() {
    setEditing(false);
    const cleaned = draft.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (cleaned && cleaned !== id) onChange(cleaned);
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(id);
            setEditing(false);
          }
        }}
        className="mt-1 ml-2 bg-card-strong rounded px-1.5 py-0.5 text-[10px] font-mono text-ink"
      />
    );
  }
  return (
    <button
      onClick={() => {
        setDraft(id);
        setEditing(true);
      }}
      className="mt-1 ml-2 text-[10px] font-mono text-ink-faint hover:text-ink-muted"
      title="Slug steps reference. Click to edit (renames break steps that already point at this participant)."
    >
      id: {id}
    </button>
  );
}

/// Heuristic: the stored name looks like a raw model id rather than a
/// human label (auto-synthesized before friendlyModelLabel was wired
/// in). Examples that match: "codex:gpt-5.4-mini", "claude-opus-4-7",
/// "gemma4:26b". Examples that DON'T match: "Primary", "Worker",
/// "Surveyor", "GPT-5.4 mini".
function looksLikeRawModelId(name: string, model: string): boolean {
  if (!name) return true;
  if (name === model) return true;
  // backend:model compound form
  if (/^[a-z]+:.+$/.test(name)) return true;
  // raw claude-style ids
  if (/^claude-[a-z]+-\d+-\d+$/.test(name)) return true;
  return false;
}
