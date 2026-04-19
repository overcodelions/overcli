import { useStore } from '../store';
import { useConversation } from '../hooks';
import { UUID } from '@shared/types';

export function StatsFooter({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const runner = useStore((s) => s.runners[conversationId]);
  const showCost = useStore((s) => s.settings.showCost);
  if (!conv) return null;
  const turns = conv.turnCount;
  const cost = conv.totalCostUSD.toFixed(4);
  return (
    <div className="flex items-center gap-2 text-[10px] text-ink-faint px-2">
      <span>{turns} turn{turns === 1 ? '' : 's'}</span>
      {showCost && <span>· ${cost}</span>}
      {runner?.currentModel && <span>· {runner.currentModel}</span>}
      {conv.sessionId && <span className="truncate">· {conv.sessionId.slice(0, 8)}</span>}
    </div>
  );
}
