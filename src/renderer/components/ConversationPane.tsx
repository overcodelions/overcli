import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { ConversationHeader } from './ConversationHeader';
import { ChatView } from './ChatView';
import { InputBar } from './InputBar';
import { StatsFooter } from './StatsFooter';
import { FileEditorPane } from './FileEditorPane';
import { ResizableDivider } from './ResizableDivider';
import { ChangesBar, computeChangedFiles } from './ChangesBar';
import { useConversation } from '../hooks';

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
  const conv = useConversation(convId);
  const events = useStore((s) => (convId ? s.runners[convId]?.events : null)) ?? null;
  const changedFiles = useMemo(
    () => (events ? computeChangedFiles(events) : []),
    [events],
  );
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
  const isOllamaConv = conv?.primaryBackend === 'ollama';
  const showOllamaWarning =
    isOllamaConv && ollamaServerStatus !== 'running' && ollamaServerStatus !== 'starting';
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
        <ChatView conversationId={convId} />
        <div className="px-4 pb-3 pt-1 flex flex-col gap-1.5">
          <ChangesBar files={changedFiles} />
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

function clamp(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.max(min, Math.min(max, w));
}
