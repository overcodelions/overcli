import { handoffReason } from '@shared/handoff';
import { handoffTarget, useHandoffsStore } from '../handoffsStore';
import { useStore } from '../store';

const WELCOME_KEY = '__welcome__';

/// The handoff you opened from the tray, above the composer it seeded. It
/// says what came in and where it landed; the evidence itself is already in
/// the draft, where you can read and edit it before anything is sent.
///
/// Clearing the draft puts the card away, not the handoff: it stays on the
/// tray until it is started or dismissed. See `initHandoffs`.
export function HandoffCard() {
  const activeId = useHandoffsStore((s) => s.activeId);
  const handoff = useHandoffsStore((s) => s.handoffs.find((h) => h.id === s.activeId) ?? null);
  const resolve = useHandoffsStore((s) => s.resolve);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const setDraft = useStore((s) => s.setDraft);

  if (!activeId || !handoff) return null;

  const target = handoffTarget(handoff, projects, workspaces);
  const where =
    target.kind === 'workspace'
      ? `Matched to the ${workspaces.find((w) => w.id === target.workspaceId)?.name ?? ''} workspace`
      : target.kind === 'project'
        ? `Matched to ${projects.find((p) => p.id === target.projectId)?.name ?? 'its project'}`
        : `No project matches ${handoff.repoHints[0] ?? 'the repo it named'} — pick one below`;

  const dismiss = () => {
    setDraft(WELCOME_KEY, '');
    void resolve(handoff.id);
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-left flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-ink-muted">{handoffReason(handoff)}</div>
        <div className="text-xs font-medium text-ink mt-0.5 truncate" title={handoff.title}>
          {handoff.title}
        </div>
        <div className="text-[11px] text-ink-muted mt-0.5">
          {where}. The report is in the message below — nothing is sent until you send it.
        </div>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 px-2.5 py-1 rounded text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
        title="Move it to done without starting a conversation"
      >
        Dismiss
      </button>
    </div>
  );
}
