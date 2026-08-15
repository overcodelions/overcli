// "Edit with AI" panel for the flow builder. Same drafting CLI that writes a
// flow from scratch, pointed at the flow already open in the editor: the user
// types a change in plain English ("add a security review before the PR
// step"), we send the draft's current YAML alongside it, and the returned
// flow replaces the draft.
//
// Two things make that safe enough to apply without a confirm dialog. The
// revision goes through the same parse/repair/validate pipeline a fresh draft
// does, so it can't leave the editor in a state a hand edit couldn't. And
// nothing is written to disk — the user still has to hit Save — so Undo here
// is just restoring the previous in-memory draft.

import { useMemo, useState } from 'react';

import type { Flow } from '@shared/flows/schema';
import { serializeFlow } from '@shared/flows/yaml';
import { pickDrafterBackend, drafterModelFor } from '@shared/flows/drafterBackend';
import { friendlyModelLabel } from '@shared/modelCatalog';
import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { backendName } from '../../theme';
import { summarizeFlowChanges } from './flowRevisionSummary';

/// Fields a revision is allowed to replace. `id`, `source`, and `filePath`
/// are the editor's business, not the model's — where this flow saves to
/// isn't something the user asked it to reconsider.
function revisionPatch(revised: Flow): Partial<Flow> {
  return {
    name: revised.name,
    description: revised.description,
    tags: revised.tags,
    defaultPrompt: revised.defaultPrompt,
    participants: revised.participants,
    steps: revised.steps,
  };
}

const EXAMPLES = [
  'Add a security review before the PR step',
  'Put the implementer on a cheaper model',
  'Pause before anything gets pushed',
  'Drop the test-writing step',
];

export function FlowAiEdit({ draft }: { draft: Flow }) {
  const updateDraft = useFlowsStore((s) => s.updateDraft);
  const backendHealth = useStore((s) => s.backendHealth);
  const settings = useStore((s) => s.settings);

  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last applied revision: the draft as it stood before it, what changed,
  // and the YAML it produced. All of it clears on the next request.
  const [applied, setApplied] = useState<
    { previous: Flow; changes: string[]; revisedYaml: string } | null
  >(null);

  // Undo restores a whole snapshot, so it's only safe while the draft is
  // still exactly what the revision produced. Once the user hand-edits on top
  // of it, undoing would silently throw that work away — so the offer goes.
  const untouched = useMemo(
    () => applied != null && serializeFlow(draft) === applied.revisedYaml,
    [applied, draft],
  );

  // Resolved the same way the main process resolves it, so the copy names
  // the CLI that actually runs.
  const backend = pickDrafterBackend({
    preferred: settings.preferredBackend,
    isHealthy: (b) => backendHealth[b]?.kind === 'ready',
    isEnabled: (b) => settings.disabledBackends?.[b] !== true,
  });
  const editorName = backend ? backendName(backend) : 'your preferred CLI';
  const modelLabel = backend ? friendlyModelLabel(backend, drafterModelFor(backend)) : null;

  async function handleRevise() {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      const result = await window.overcli.invoke('flows:reviseFromPrompt', {
        yaml: serializeFlow(draft),
        instruction: text,
        id: draft.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const patch = revisionPatch(result.flow);
      setApplied({
        previous: draft,
        changes: summarizeFlowChanges(draft, result.flow),
        revisedYaml: serializeFlow({ ...draft, ...patch }),
      });
      updateDraft(patch);
      setInstruction('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleUndo() {
    if (!applied) return;
    updateDraft(revisionPatch(applied.previous));
    setApplied(null);
  }

  // Expanded only while the user is actually working in it. At rest this is
  // one input-height row so it never outweighs the flow it edits.
  const expanded = focused || instruction.length > 0;

  return (
    <div className="mb-4">
      <div className="flex items-start gap-2 rounded-lg border border-card bg-card px-3 py-1.5 focus-within:border-card-strong transition-colors">
        <span className="text-xs text-ink-faint select-none leading-6" aria-hidden>
          ✨
        </span>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits — Enter alone stays a newline so a
            // multi-sentence instruction doesn't fire off half-written.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleRevise();
            }
          }}
          rows={1}
          disabled={busy}
          // `field-sizing: content` grows the box with the text instead of
          // reserving rows up front (same trick the chat composer uses), so
          // the resting state is a single line.
          style={{ fieldSizing: 'content', maxHeight: 160 } as React.CSSProperties}
          placeholder="Edit with AI — describe a change to this flow…"
          className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none resize-none leading-6 disabled:opacity-60"
        />
        {(busy || instruction.trim()) && (
          <button
            onClick={handleRevise}
            disabled={busy || !instruction.trim()}
            className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap self-center"
            title="⌘↵"
          >
            {busy ? 'Revising…' : 'Apply'}
          </button>
        )}
      </div>

      {expanded && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1">
          {!instruction &&
            EXAMPLES.map((ex) => (
              <button
                key={ex}
                // Blur fires before click, and blur collapses this row — so
                // claim the press before the row can disappear under it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setInstruction(ex)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              >
                {ex}
              </button>
            ))}
          <span className="ml-auto text-[10px] text-ink-faint">
            {modelLabel ? `${modelLabel} · ` : ''}⌘↵ to apply · you review before saving
          </span>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2.5 mt-2">
          {error}
        </div>
      )}

      {applied && (
        <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 border border-emerald-500/20 rounded p-2 mt-2">
          <div className="flex-1">
            {applied.changes.length === 0 ? (
              <>
                {editorName} returned the flow unchanged — try being more specific about what to
                add, drop, or move.
              </>
            ) : (
              <>Applied: {applied.changes.join(', ')} — nothing is saved until you hit Save.</>
            )}
          </div>
          {applied.changes.length > 0 && untouched && (
            <button
              onClick={handleUndo}
              className="underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
            >
              Undo
            </button>
          )}
          <button
            onClick={() => setApplied(null)}
            aria-label="Dismiss"
            className="opacity-60 hover:opacity-100 leading-none"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
