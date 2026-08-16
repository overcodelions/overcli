// The one-off task channel for a standing worker. Lives apart from
// WorkersPane so anything that wants to mount it can, without importing the
// pane back.

import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import type { Worker } from '@shared/flows/worker';
import { ActivityStrip } from '../ActivityStrip';
import { Composer } from '../Composer';

/// The shared one-off task channel. An errand is deliberately directed to a
/// standing worker, so main can judge it through the worker's job, journal,
/// budget, and trust rules instead of treating it as a generic prompt.
///
/// It uses the app's own `Composer` rather than a bespoke textarea: this is a
/// chat box and should be the same chat box as everywhere else — the same
/// @-mention file lookup (rooted at the worker's project), the same ArrowUp
/// prompt history, the same drag-and-drop and paste handling. A worker is a
/// person you talk to; talking to it should not feel like filling in a form.
export function WorkerErrandComposer({ worker }: { worker: Worker }) {
  const busy = useWorkersStore((s) => !!s.errandBusy[worker.id]);
  const error = useWorkersStore((s) => s.errandError[worker.id]);
  const result = useWorkersStore((s) => s.errandResult[worker.id]);
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const runErrand = useWorkersStore((s) => s.runErrand);
  const clearErrand = useWorkersStore((s) => s.clearErrand);
  const setDraft = useStore((s) => s.setDraft);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const draftKey = `worker-errand:${worker.id}`;
  // Never disabled. A worker mid-shift can be handed an errand the same way a
  // person can: it waits its turn (the engine queues it behind the turn in
  // flight) instead of the box refusing your typing. Disabling it meant the
  // moment you most wanted to say something — you can see it working — was the
  // one moment you couldn't.
  const waiting = busy || !!shift;

  // Pinned above the input, exactly where a conversation puts it — the
  // "still working" cue belongs in the fixed composer area, not trailing the
  // transcript where a long reply scrolls it out of sight.
  const activity = shift
    ? shift.tools[shift.tools.length - 1] ||
      (shift.task === 'errand' ? 'On your errand…' : 'Working a shift…')
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      {activity && <ActivityStrip label={activity} />}
      <Composer
        // Per-worker draft key: a half-typed errand to one worker survives a
        // trip to another's desk, the way a half-typed chat survives.
        draftKey={draftKey}
        variant="compact"
        rootPath={worker.projectPath}
        placeholder={
          waiting
            ? `Send ${worker.name} an errand — it starts when ${
                shift?.task === 'shift' ? 'the shift' : 'the current one'
              } finishes…`
            : `Send ${worker.name} an errand — a one-off task, in its own words…`
        }
        onSend={(prompt, attachments) => {
          // Composer's `commit` hands the text off but does not empty itself —
          // in chat, `store.send` clears the draft and attachments for the key.
          // The errand path has to do the same or the message you just sent
          // sits in the box looking unsent.
          setDraft(draftKey, '');
          for (const attachment of attachments) removeAttachment(draftKey, attachment.id);
          void runErrand(worker.id, prompt, attachments);
        }}
      />
      {error && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            onClick={() => clearErrand(worker.id)}
            className="shrink-0 text-ink-faint hover:text-ink"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {/* A one-line receipt, not the reply. The errand's batch lands in the
          timeline the moment it settles, carrying the worker's prose and its
          items — rendering that here too was the thing that spilled out of the
          row. Neutral wording: zero candidates is a refusal, an answered
          question, or nothing worth doing, and only the prose tells you which. */}
      {result && (
        <div className="mt-1.5 flex items-center gap-1.5 px-1 text-[10px]">
          <span
            className={
              'min-w-0 flex-1 truncate ' +
              (result.launchedNothing ? 'text-ink-muted' : 'text-emerald-600 dark:text-emerald-400')
            }
          >
            {result.launchedNothing
              ? `${worker.name} replied — nothing launched`
              : `${result.count} planned · ${result.queued} launched`}
          </span>
          <button
            onClick={() => clearErrand(worker.id)}
            className="shrink-0 text-ink-faint hover:text-ink"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
