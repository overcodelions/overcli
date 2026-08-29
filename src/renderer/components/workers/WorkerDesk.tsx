// The one-off task channel for a standing worker. Lives apart from
// WorkersPane so anything that wants to mount it can, without importing the
// pane back.

import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import type { Worker } from '@shared/flows/worker';
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
  const error = useWorkersStore((s) => s.errandError[worker.id]);
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
  return (
    <div className="flex flex-col gap-1.5">
      {/* No mode switch. The desk used to ask you to declare "Ask" or
          "Create work" before sending, which is a classification you cannot
          reliably make until you have had the conversation that settles it —
          so a question got answered as a work request, or a work request came
          back as prose. The worker's own triage already chooses between
          answering, proposing against its flows, and asking for a flow; it
          reads the message, which is strictly more than the toggle knew.
          Anything it proposes parks for your approval, so the cost of it
          guessing "work" when you meant "question" is a card you dismiss. */}
      <Composer
        // Per-worker draft key: a half-typed errand to one worker survives a
        // trip to another's desk, the way a half-typed chat survives.
        draftKey={draftKey}
        variant="compact"
        strongBorder
        rootPath={worker.projectPath}
        placeholder={`Message ${worker.name}…`}
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
    </div>
  );
}
