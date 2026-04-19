import { CodexApprovalInfo, UUID } from '@shared/types';
import { useStore } from '../store';

export function CodexApprovalCard({ info, conversationId }: { info: CodexApprovalInfo; conversationId: UUID }) {
  const respond = useStore((s) => s.respondCodexApproval);
  return (
    <div className="rounded-lg border border-orange-500/30 bg-orange-500/8 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-orange-400 font-medium">
        <span>⚠</span>
        <span>codex approval: {info.kind}</span>
        {info.decided && (
          <span className={'ml-auto text-[10px] ' + (info.decided === 'allow' ? 'text-green-400' : 'text-red-400')}>
            {info.decided === 'allow' ? '✓ approved' : '✗ denied'}
          </span>
        )}
      </div>
      {info.command && (
        <pre className="mt-1 text-[11px] font-mono bg-black/30 rounded px-2 py-1 overflow-x-auto select-text">
          {info.command}
        </pre>
      )}
      {info.changesSummary && (
        <pre className="mt-1 text-[11px] font-mono bg-black/30 rounded px-2 py-1 overflow-x-auto select-text text-ink-muted">
          {info.changesSummary}
        </pre>
      )}
      {info.reason && <div className="mt-1 text-[11px] text-ink-faint">{info.reason}</div>}
      {!info.decided && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void respond(conversationId, info.callId, info.kind, true)}
            className="px-3 py-1 rounded text-xs bg-orange-500/25 text-orange-100 hover:bg-orange-500/40"
          >
            Approve
          </button>
          <button
            onClick={() => void respond(conversationId, info.callId, info.kind, false)}
            className="px-3 py-1 rounded text-xs bg-card text-ink-muted hover:bg-card-strong border border-card"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
