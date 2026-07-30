import { useStore } from '../store';
import { useRunner } from '../runnersStore';
import { useConversation } from '../hooks';
import { CompactButton } from './CompactButton';
import { ContextMeter } from './ContextMeter';
import { UUID } from '@shared/types';

/// `send` clears the composer as a side effect — right for a typed
/// message, wrong for a button. The draft you'd want to keep is exactly
/// the one you were writing when you noticed the window was full, so
/// snapshot it and put it back. `send` clears synchronously via `set()`
/// before its first await, so restoring after the call is safe.
async function compactPreservingDraft(
  conversationId: UUID,
  send: (id: UUID, prompt: string) => Promise<void>,
): Promise<void> {
  const { conversationDrafts, setDraft } = useStore.getState();
  const draft = conversationDrafts[conversationId] ?? '';
  await send(conversationId, '/compact');
  if (draft) setDraft(conversationId, draft);
}

export function StatsFooter({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const runner = useRunner(conversationId);
  const showCost = useStore((s) => s.settings.showCost);
  const send = useStore((s) => s.send);
  if (!conv) return null;
  const turns = conv.turnCount;
  const cost = conv.totalCostUSD.toFixed(4);
  // Slash commands are a Claude Code feature; the other backends would
  // just receive "/compact" as a literal prompt.
  const canCompact = conv.primaryBackend === 'claude';
  return (
    <div className="flex items-center gap-2 text-[10px] text-ink-faint px-2">
      <span>{turns} turn{turns === 1 ? '' : 's'}</span>
      {showCost && <span>· ${cost}</span>}
      <ContextMeter conversationId={conversationId} />
      {canCompact && (
        <CompactButton
          onCompact={() => void compactPreservingDraft(conversationId, send)}
          disabled={runner?.isRunning}
        />
      )}
      {runner?.currentModel && <span>· {runner.currentModel}</span>}
      {conv.sessionId && <span className="truncate">· {conv.sessionId.slice(0, 8)}</span>}
    </div>
  );
}
