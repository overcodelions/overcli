// The one-off task channel for a standing worker. Lives apart from
// WorkersPane so anything that wants to mount it can, without importing the
// pane back.

import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import type { Worker } from '@shared/flows/worker';
import type { WorkerMessageIntent } from '@shared/flows/worker';
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
export function WorkerErrandComposer({ worker, intent = 'chat', onIntentChange }: { worker: Worker; intent?: WorkerMessageIntent; onIntentChange?: (intent: WorkerMessageIntent) => void }) {
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
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <div className="flex items-center gap-2">
          <span className={intent === 'work' ? 'font-medium text-violet-500' : 'font-medium text-ink-muted'}>
            {intent === 'work' ? 'Create work' : 'Ask'}
          </span>
          <button
            type="button"
            aria-pressed={intent === 'work'}
            onClick={() => onIntentChange?.(intent === 'chat' ? 'work' : 'chat')}
            className="rounded-md border border-card-strong px-2 py-1 text-ink-faint hover:border-violet-400/40 hover:text-ink"
          >
            {intent === 'chat' ? 'Create work…' : 'Back to Ask'}
          </button>
        </div>
        <span className="text-ink-faint">{intent === 'chat' ? 'Replies here; no flow starts.' : 'May use or draft a flow; trust rules still apply.'}</span>
      </div>
      <Composer
        // Per-worker draft key: a half-typed errand to one worker survives a
        // trip to another's desk, the way a half-typed chat survives.
        draftKey={draftKey}
        variant="compact"
        rootPath={worker.projectPath}
        placeholder={intent === 'chat' ? `Message ${worker.name}…` : `Describe the outcome for ${worker.name} to produce…`}
        onSend={(prompt, attachments) => {
          // Composer's `commit` hands the text off but does not empty itself —
          // in chat, `store.send` clears the draft and attachments for the key.
          // The errand path has to do the same or the message you just sent
          // sits in the box looking unsent.
          setDraft(draftKey, '');
          for (const attachment of attachments) removeAttachment(draftKey, attachment.id);
          void runErrand(worker.id, prompt, intent, attachments);
          // Create work is an explicit one-message escalation. Follow-ups go
          // back to normal conversation unless the user chooses it again.
          if (intent === 'work') onIntentChange?.('chat');
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
