import { PermissionRequestInfo, UUID } from '@shared/types';
import { useStore } from '../store';

export function PermissionCard({ info, conversationId }: { info: PermissionRequestInfo; conversationId: UUID }) {
  const respond = useStore((s) => s.respondPermission);
  const decided = info.decided;
  const label = info.backend ?? 'agent';
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/8 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-blue-400 font-medium">
        <span>🔒</span>
        <span>{label} wants to use {info.toolName}</span>
        {decided && (
          <span className={'ml-auto text-[10px] ' + (decided === 'allow' ? 'text-green-400' : 'text-red-400')}>
            {decided === 'allow' ? '✓ allowed' : '✗ denied'}
          </span>
        )}
      </div>
      {info.description && <div className="mt-1 text-ink-muted">{info.description}</div>}
      {info.toolInput && (
        <pre className="mt-1 text-[11px] font-mono bg-black/30 rounded px-2 py-1 overflow-x-auto select-text">
          {info.toolInput}
        </pre>
      )}
      {!decided && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void respond(conversationId, info.requestId, true)}
            className="px-3 py-1 rounded text-xs bg-blue-500/25 text-blue-100 hover:bg-blue-500/40"
          >
            Allow
          </button>
          <button
            onClick={() => void respond(conversationId, info.requestId, false)}
            className="px-3 py-1 rounded text-xs bg-card text-ink-muted hover:bg-card-strong border border-card"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
