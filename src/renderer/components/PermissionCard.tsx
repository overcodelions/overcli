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
  // Artifact and DesignSync both send something outward, and both carry
  // inputs that read terribly raw: an Artifact call inlines the whole
  // document, and a DesignSync plan is a path list. Summarize the part that
  // decides the answer and keep the JSON underneath.
  const outbound = outboundSummary(info.toolName, info.toolInput);
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
      {outbound && (
        <div className="mt-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <div className="text-[11px] font-medium text-amber-700 dark:text-amber-200">
            {outbound.headline}
          </div>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            {outbound.rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-ink-faint">{r.label}</dt>
                <dd className="font-mono break-all select-text">{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
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
            className="px-3 py-1 rounded text-xs bg-accent text-white hover:bg-accent-600"
          >
            Allow
          </button>
          <button
            onClick={() =>
              void respond(conversationId, info.requestId, true, undefined, 'always', info.toolName)
            }
            className="px-3 py-1 rounded text-xs bg-accent/10 text-accent hover:bg-accent/20 border border-accent/40"
            title={`Auto-approve ${info.toolName} for the rest of this session`}
          >
            Always allow
          </button>
          {canAddDir && addDirTarget && (
            <button
              onClick={() => void respond(conversationId, info.requestId, true, addDirTarget)}
              className="px-3 py-1 rounded text-xs bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 dark:text-amber-200"
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

interface OutboundSummary {
  headline: string;
  rows: { label: string; value: string }[];
}

/// Plain-language summary for the tools that leave the machine. Returns null
/// for everything else, which is most tools — the generic card is fine when
/// the effect is local and reversible.
function outboundSummary(toolName: string, toolInput?: string): OutboundSummary | null {
  if (toolName !== 'Artifact' && toolName !== 'DesignSync') return null;
  let input: any;
  try {
    input = JSON.parse(toolInput ?? '');
  } catch {
    // A malformed or partial input is exactly when the user should be
    // reading the raw JSON below rather than a summary we invented.
    return null;
  }
  if (toolName === 'Artifact') {
    const caps = input?.capabilities ? Object.keys(input.capabilities) : [];
    return {
      headline: 'Publishes this file to claude.ai as a shareable artifact.',
      rows: [
        ...(input?.title ? [{ label: 'Title', value: String(input.title) }] : []),
        ...(input?.file_path ? [{ label: 'File', value: String(input.file_path) }] : []),
        ...(caps.length ? [{ label: 'Grants', value: caps.join(', ') }] : []),
      ],
    };
  }
  const method = String(input?.method ?? '');
  // Only the plan boundary and the writes that ride on it actually send
  // content; list_projects and friends are reads and don't warrant a banner.
  if (method === 'finalize_plan') {
    const writes: string[] = Array.isArray(input?.writes) ? input.writes : [];
    const deletes: string[] = Array.isArray(input?.deletes) ? input.deletes : [];
    return {
      headline: 'Locks the paths this session may write to and delete from your Claude Design project.',
      rows: [
        { label: 'Writes', value: pathList(writes) },
        { label: 'Deletes', value: deletes.length ? pathList(deletes) : 'none' },
        { label: 'Reads from', value: String(input?.localDir ?? 'the working directory') },
      ],
    };
  }
  if (method === 'write_files' || method === 'delete_files') {
    const n = Array.isArray(input?.files)
      ? input.files.length
      : Array.isArray(input?.paths)
      ? input.paths.length
      : 0;
    return {
      headline:
        method === 'write_files'
          ? `Uploads ${n} file${n === 1 ? '' : 's'} to your Claude Design project.`
          : `Deletes ${n} path${n === 1 ? '' : 's'} from your Claude Design project.`,
      rows: [],
    };
  }
  return null;
}

/// Show enough of a path list to recognize the shape of the change without
/// letting a 256-entry plan push the buttons off screen.
function pathList(paths: string[]): string {
  if (!paths.length) return 'none';
  const shown = paths.slice(0, 6).join(', ');
  return paths.length > 6 ? `${shown} +${paths.length - 6} more` : shown;
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
