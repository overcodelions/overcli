import { PermissionRequestInfo, UUID } from '@shared/types';
import { useStore } from '../store';

export function PermissionCard({ info, conversationId }: { info: PermissionRequestInfo; conversationId: UUID }) {
  const respond = useStore((s) => s.respondPermission);
  const decided = info.decided;
  const label = info.backend ?? 'agent';
  // Offer "Allow + Add Dir" only when the main process flagged the path
  // as outside the conversation's current scope — otherwise the plain
  // Allow is already enough and the extra button is noise.
  const canAddDir = !!info.requestedPath && !!info.outsideAllowedDirs;
  const addDirTarget = canAddDir ? deriveDirToAdd(info.requestedPath!) : null;
  // AskUserQuestion's toolInput is just the serialized question/options
  // payload the UI already renders as a form right above this card, so
  // the raw JSON here is pure noise. Suppress it for that tool.
  const showToolInput = info.toolName !== 'AskUserQuestion';
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/8 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-blue-400 font-medium">
        <LockIcon />
        <span>{label} wants to use {info.toolName}</span>
        {decided && (
          <span className={'ml-auto text-[10px] ' + (decided === 'allow' ? 'text-green-400' : 'text-red-400')}>
            {decided === 'allow' ? '✓ allowed' : '✗ denied'}
          </span>
        )}
      </div>
      {info.description && <div className="mt-1 text-ink-muted">{info.description}</div>}
      {info.toolInput && showToolInput && (
        <pre className="mt-1 text-[11px] font-mono bg-black/30 rounded px-2 py-1 overflow-x-auto select-text">
          {info.toolInput}
        </pre>
      )}
      {canAddDir && addDirTarget && (
        <div className="mt-1 text-[11px] text-amber-300">
          Path is outside this session. "Allow + Add Dir" adds <code>{addDirTarget}</code> for future turns.
        </div>
      )}
      {!decided && (
        <div className="mt-2 flex gap-2 flex-wrap">
          <button
            onClick={() => void respond(conversationId, info.requestId, true)}
            className="px-3 py-1 rounded text-xs bg-blue-500/25 text-blue-100 hover:bg-blue-500/40"
          >
            Allow
          </button>
          <button
            onClick={() =>
              void respond(conversationId, info.requestId, true, undefined, 'always', info.toolName)
            }
            className="px-3 py-1 rounded text-xs bg-blue-500/15 text-blue-100 hover:bg-blue-500/30 border border-blue-500/40"
            title={`Auto-approve ${info.toolName} for the rest of this session`}
          >
            Always allow
          </button>
          {canAddDir && addDirTarget && (
            <button
              onClick={() => void respond(conversationId, info.requestId, true, addDirTarget)}
              className="px-3 py-1 rounded text-xs bg-amber-500/25 text-amber-100 hover:bg-amber-500/40"
            >
              Allow + Add Dir
            </button>
          )}
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

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/// Claude wants access to a specific file most of the time, but the
/// directory gate works on directory roots. Strip the last segment when
/// the path looks like a file (has an extension), otherwise use it as-is.
function deriveDirToAdd(p: string): string {
  const last = p.split('/').pop() ?? '';
  const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(last);
  if (!looksLikeFile) return p;
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : p;
}
