import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useRunnerEvents } from '../runnersStore';
import { ConversationHeader } from './ConversationHeader';
import { ChatView } from './ChatView';
import { InputBar } from './InputBar';
import { StatsFooter } from './StatsFooter';
import { FileEditorPane } from './FileEditorPane';
import { ResizableDivider } from './ResizableDivider';
import { ChangesBar } from './ChangesBar';
import { useConversation } from '../hooks';
import { Backend } from '@shared/types';
import { backendName } from '../theme';

const EDITOR_MIN = 320;
// Chat must keep at least this many px; editor caps at (container - CHAT_MIN).
const CHAT_MIN = 360;

export function ConversationPane() {
  const convId = useStore((s) => s.selectedConversationId);
  const openFilePath = useStore((s) => s.openFilePath);
  const showFileTree = useStore((s) => s.showFileTree);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const ollamaServerStatus = useStore((s) => s.ollamaServerStatus);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const backendHealth = useStore((s) => s.backendHealth);
  const refreshBackendHealth = useStore((s) => s.refreshBackendHealth);
  const conv = useConversation(convId);
  const events = useRunnerEvents(convId);
  const gitStatus = useStore((s) => (convId ? s.gitStatusByConv[convId] : undefined));
  const refreshGitStatus = useStore((s) => s.refreshGitStatus);
  // Count of file-modifying tool uses in this conversation. When it
  // changes we re-probe git — that keeps the ChangesBar and the
  // header +/- badge in lockstep with the working tree.
  const editCount = useMemo(() => {
    if (!events) return 0;
    let n = 0;
    for (const e of events) {
      if (e.kind.type === 'assistant') {
        for (const u of e.kind.info.toolUses) {
          if (u.name === 'Edit' || u.name === 'MultiEdit' || u.name === 'Write') n += 1;
        }
      } else if (e.kind.type === 'patchApply') {
        n += 1;
      }
    }
    return n;
  }, [events]);
  useEffect(() => {
    if (!convId) return;
    void refreshGitStatus(convId);
  }, [convId, editCount, refreshGitStatus]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);
  const editorMax = Math.max(EDITOR_MIN + 40, containerWidth - CHAT_MIN);
  const [width, setWidth] = useState(
    () => clamp(settings.editorPaneWidth ?? 540, EDITOR_MIN, editorMax),
  );
  useEffect(() => {
    setWidth((w) => clamp(settings.editorPaneWidth ?? w, EDITOR_MIN, editorMax));
  }, [settings.editorPaneWidth, editorMax]);

  if (!convId) return null;
  const editorVisible = !!openFilePath || showFileTree;
  const convBackend = conv?.primaryBackend;
  const isOllamaConv = convBackend === 'ollama';
  const showOllamaWarning =
    isOllamaConv && ollamaServerStatus !== 'running' && ollamaServerStatus !== 'starting';
  const showAuthBanner =
    !!convBackend &&
    convBackend !== 'ollama' &&
    backendHealth[convBackend]?.kind === 'unauthenticated';
  return (
    <div ref={containerRef} className="flex flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-w-0">
        <ConversationHeader conversationId={convId} />
        {showOllamaWarning && (
          <OllamaServerDownBanner
            status={ollamaServerStatus}
            onStart={async () => {
              await window.overcli.invoke('ollama:startServer');
            }}
            onOpenLocalTab={() => setDetailMode('local')}
          />
        )}
        {showAuthBanner && convBackend && (
          <BackendAuthBanner
            backend={convBackend}
            onRefresh={() => void refreshBackendHealth()}
          />
        )}
        <ChatView conversationId={convId} />
        <div className="px-4 pb-3 pt-1 flex flex-col gap-1.5">
          <ChangesBar files={gitStatus?.changes ?? []} />
          <InputBar conversationId={convId} />
          <StatsFooter conversationId={convId} />
        </div>
      </div>
      {editorVisible && (
        <>
          <ResizableDivider
            width={width}
            onChange={setWidth}
            onCommit={(w) => void saveSettings({ ...settings, editorPaneWidth: w })}
            minWidth={EDITOR_MIN}
            maxWidth={editorMax}
            side="right"
          />
          <div
            style={{ width }}
            className="flex-shrink-0 h-full border-l border-card overflow-hidden"
          >
            <FileEditorPane />
          </div>
        </>
      )}
    </div>
  );
}

function OllamaServerDownBanner({
  status,
  onStart,
  onOpenLocalTab,
}: {
  status: string;
  onStart: () => Promise<void>;
  onOpenLocalTab: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const label =
    status === 'error'
      ? 'Ollama server errored — check the Local tab for details.'
      : 'Ollama server isn\'t running. Start it to send messages.';
  return (
    <div className="mx-4 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center gap-3">
      <span className="flex-1">{label}</span>
      <button
        onClick={async () => {
          setStarting(true);
          try {
            await onStart();
          } finally {
            setStarting(false);
          }
        }}
        disabled={starting}
        className="px-2 py-1 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
      >
        {starting ? 'Starting…' : 'Start server'}
      </button>
      <button
        onClick={onOpenLocalTab}
        className="px-2 py-1 rounded text-amber-200/70 hover:text-amber-100"
      >
        Open Local tab
      </button>
    </div>
  );
}

/// Shown above the chat when the selected backend's CLI is installed but
/// not authenticated. Clicking "Sign in" opens Terminal.app with the
/// backend's login command pre-typed so the user completes the flow
/// (usually a browser OAuth round-trip) outside Electron. While the banner
/// is visible we poll health every few seconds so it disappears on its
/// own the moment auth succeeds.
function BackendAuthBanner({
  backend,
  onRefresh,
}: {
  backend: Backend;
  onRefresh: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);

  useEffect(() => {
    if (!launched) return;
    const id = setInterval(onRefresh, 3000);
    return () => clearInterval(id);
  }, [launched, onRefresh]);

  const label = launched
    ? `Finish signing into ${backendName(backend)} in the Terminal window, then come back.`
    : `You're signed out of ${backendName(backend)}. Sign in to send messages.`;

  return (
    <div className="mx-4 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center gap-3">
      <span className="flex-1">{label}</span>
      {launchError && <span className="text-amber-300/80">{launchError}</span>}
      <button
        onClick={async () => {
          setLaunching(true);
          setLaunchError(null);
          try {
            const res = await window.overcli.invoke('auth:openCliLogin', backend);
            if (res.ok) setLaunched(true);
            else setLaunchError(res.error);
          } finally {
            setLaunching(false);
          }
        }}
        disabled={launching}
        className="px-2 py-1 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
      >
        {launching ? 'Opening Terminal…' : launched ? 'Reopen Terminal' : 'Sign in'}
      </button>
      <button
        onClick={onRefresh}
        className="px-2 py-1 rounded text-amber-200/70 hover:text-amber-100"
      >
        Refresh
      </button>
    </div>
  );
}

function clamp(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
