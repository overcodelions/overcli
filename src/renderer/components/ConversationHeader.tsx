import { CSSProperties, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Backend, Conversation, PermissionMode, UUID, EffortLevel, StreamEvent } from '@shared/types';
import { backendColor, backendName, shortModel } from '../theme';
import { useConversation } from '../hooks';
import { findOwningProjectPath } from '../diff-utils';

/// Full-featured header matching the Swift ConversationHeader:
/// backend picker, permission mode picker, effort picker (claude),
/// rebound (reviewer) popover, tool-activity toggle, file-tree toggle,
/// conversation settings popover, overflow menu.
export function ConversationHeader({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const backendHealth = useStore((s) => s.backendHealth);
  const installedReviewers = useStore((s) => s.installedReviewers);
  const setPrimary = useStore((s) => s.setPrimaryBackend);
  const setPermission = useStore((s) => s.setPermissionMode);
  const setEffort = useStore((s) => s.setEffortLevel);
  const setModel = useStore((s) => s.setBackendModel);
  const setReviewBackend = useStore((s) => s.setReviewBackend);
  const setReviewMode = useStore((s) => s.setReviewMode);
  const setReviewOllamaModel = useStore((s) => s.setReviewOllamaModel);
  const setReviewYolo = useStore((s) => s.setReviewYolo);
  const promoteReviewAgent = useStore((s) => s.promoteReviewAgent);
  const checkoutReviewBranchLocally = useStore((s) => s.checkoutReviewBranchLocally);
  const removeAgent = useStore((s) => s.removeAgent);
  const runnerIsRunning = useStore((s) => s.runners[conversationId]?.isRunning ?? false);
  const runnerModel = useStore((s) => s.runners[conversationId]?.currentModel ?? '');
  const codexRuntimeMode = useStore((s) => s.runners[conversationId]?.codexRuntimeMode);
  const codexSandboxMode = useStore((s) => s.runners[conversationId]?.codexSandboxMode ?? '');
  const codexApprovalPolicy = useStore((s) => s.runners[conversationId]?.codexApprovalPolicy ?? '');
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const resetConversation = useStore((s) => s.resetConversation);
  const openSheet = useStore((s) => s.openSheet);
  const showToolActivity = useStore((s) => s.showToolActivity);
  const toggleToolActivity = useStore((s) => s.toggleToolActivity);
  const showFileTree = useStore((s) => s.showFileTree);
  const toggleFileTree = useStore((s) => s.toggleFileTree);
  const [confirmingReset, setConfirmingReset] = useState(false);
  if (!conv) return null;
  const locked = runnerIsRunning || !!conv.sessionId || conv.turnCount > 0;
  const enabled = enabledBackends(settings);
  const fallbackBackend = enabled[0] ?? 'claude';
  const backend: Backend = conv.primaryBackend ?? fallbackBackend;
  const activePermissionMode = conv.permissionMode ?? 'default';
  const pendingPermissionMode = conv.pendingPermissionMode;
  const configuredModel =
    backend === 'codex'
      ? conv.codexModel ?? conv.currentModel
      : backend === 'gemini'
      ? conv.geminiModel ?? conv.currentModel
      : conv.claudeModel ?? conv.currentModel;
  const sessionModel = runnerModel || configuredModel || settings.backendDefaultModels[backend] || '';

  return (
    <header className="flex items-center gap-2 px-4 py-2 border-b border-card">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {conv.worktreePath && (
            <span className="text-xs text-ink-faint inline-flex items-center">
              {conv.reviewAgent ? (
                conv.reviewAgentKind === 'docs' ? <DocsIcon /> : <EyeIcon />
              ) : (
                '⎇'
              )}
            </span>
          )}
          <div className="text-sm font-medium truncate">{conv.name}</div>
          {conv.reviewAgent && (
            <HeaderBadge
              title={
                conv.reviewAgentKind === 'docs'
                  ? `Docs for ${conv.reviewTargetBranch} (vs ${conv.baseBranch})`
                  : `Reviewing ${conv.reviewTargetBranch} against ${conv.baseBranch}`
              }
              style={{ color: '#c29bff' }}
            >
              {conv.reviewAgentKind === 'docs' ? 'docs' : 'review'}
            </HeaderBadge>
          )}
          {locked ? (
            <>
              <HeaderBadge
                title={`Session backend: ${backendName(backend)} CLI`}
                style={{ color: backendColor(backend) }}
              >
                {backendName(backend)} CLI
              </HeaderBadge>
              {sessionModel && (
                <HeaderBadge title={`Session model: ${sessionModel}`} pulse={runnerIsRunning}>
                  {shortModel(sessionModel)}
                </HeaderBadge>
              )}
              {pendingPermissionMode && (
                <HeaderBadge
                  title={`Permission mode changes to ${modeLabel(pendingPermissionMode)} on the next turn.`}
                  style={{ color: permissionTone(pendingPermissionMode) ?? '#f7b267' }}
                >
                  Next turn: {modeLabel(pendingPermissionMode)}
                </HeaderBadge>
              )}
              {backend === 'codex' && codexRuntimeMode === 'exec' && (
                <HeaderBadge
                  title={`Codex exec compatibility mode. Spawn flags: -s ${codexSandboxMode} -a ${codexApprovalPolicy}`}
                >
                  exec · -s {codexSandboxMode} · -a {codexApprovalPolicy}
                </HeaderBadge>
              )}
            </>
          ) : configuredModel ? (
            <span className="text-[10px] text-ink-faint">{shortModel(configuredModel)}</span>
          ) : null}
          {!locked && pendingPermissionMode && (
            <HeaderBadge
              title={`Permission mode changes to ${modeLabel(pendingPermissionMode)} on the next turn.`}
              style={{ color: permissionTone(pendingPermissionMode) ?? '#f7b267' }}
            >
              Next turn: {modeLabel(pendingPermissionMode)}
            </HeaderBadge>
          )}
        </div>
        {conv.worktreePath && (
          <div className="text-[10px] text-ink-faint truncate">
            {conv.branchName} · {conv.worktreePath}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        {!locked && (
          <IconPicker
            icon={<BackendDot color={backendColor(backend)} />}
            label={backendName(backend)}
            items={enabled.map((b) => ({
              value: b,
              label: backendName(b),
              disabled: backendHealth[b]?.kind !== 'ready',
              note:
                backendHealth[b]?.kind === 'unauthenticated'
                  ? 'auth needed'
                  : b === 'ollama' && backendHealth[b]?.kind === 'missing'
                  ? 'set up'
                  : undefined,
              leading: <BackendDot color={backendColor(b)} />,
            }))}
            onPick={(v) => void setPrimary(conversationId, v as Backend)}
          />
        )}

        <ForkPicker conversationId={conversationId} />


        <IconPicker
          icon={<ShieldIcon tone={permissionTone(pendingPermissionMode ?? activePermissionMode)} />}
          label={modeLabel(pendingPermissionMode ?? activePermissionMode)}
          tone={permissionTone(pendingPermissionMode ?? activePermissionMode)}
          items={(['plan', 'default', 'acceptEdits', 'bypassPermissions'] as PermissionMode[]).map((m) => ({
            value: m,
            label: modeLabel(m),
          }))}
          onPick={(v) => void setPermission(conversationId, v as PermissionMode)}
        />

        {backend === 'claude' && (
          <IconPicker
            icon={<BrainIcon />}
            label={effortLabel(conv.effortLevel ?? '')}
            items={([
              { value: '', label: 'Default' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'max', label: 'Max' },
            ] as { value: EffortLevel; label: string }[]).map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onPick={(v) => void setEffort(conversationId, v as EffortLevel)}
          />
        )}

        <ReboundPicker
          conv={conv}
          installedReviewers={installedReviewers}
          onSelectBackend={(b) => void setReviewBackend(conversationId, b)}
          onSelectMode={(m) => void setReviewMode(conversationId, m)}
          onSelectOllamaModel={(m) => void setReviewOllamaModel(conversationId, m)}
          onToggleYolo={(v) => void setReviewYolo(conversationId, v)}
        />

        <IconButton
          active={showToolActivity}
          onClick={toggleToolActivity}
          title={showToolActivity ? 'Hide tool activity' : 'Show tool activity'}
        >
          {showToolActivity ? <EyeIcon /> : <EyeOffIcon />}
        </IconButton>

        <IconButton
          active={showFileTree}
          onClick={toggleFileTree}
          title={showFileTree ? 'Hide file tree' : 'Show file tree'}
        >
          <FolderIcon />
        </IconButton>

        <CommitButton conversationId={conversationId} />

        {conv.reviewAgent ? (
          <ReviewAgentActions
            conversationId={conversationId}
            targetBranch={conv.reviewTargetBranch ?? ''}
            hasWorktree={!!conv.worktreePath}
            kind={conv.reviewAgentKind === 'docs' ? 'docs' : 'review'}
            onPromote={async () => {
              const res = await promoteReviewAgent(conversationId);
              if (!res.ok) window.alert(res.error);
            }}
            onCheckoutLocally={async () => {
              const target = conv.reviewTargetBranch ?? '';
              if (!window.confirm(
                `Check out ${stripOriginPrefix(target)} in your main project repo? The review worktree will be removed and any WIP in the project tree will be auto-stashed.`,
              )) return;
              const res = await checkoutReviewBranchLocally(conversationId);
              if (!res.ok) window.alert(res.error);
            }}
            onDismiss={async () => {
              if (!window.confirm('Remove this agent? The conversation and any worktree will be deleted.')) return;
              const res = await removeAgent(conversationId);
              if (!res.ok && res.error) window.alert(res.error);
            }}
          />
        ) : (
          (conv.worktreePath || (conv.workspaceAgentMemberIds?.length ?? 0) > 0) && (
            <button
              onClick={() =>
                openSheet(
                  (conv.workspaceAgentMemberIds?.length ?? 0) > 0
                    ? { type: 'workspaceAgentReview', coordinatorId: conversationId }
                    : { type: 'worktreeDiff', convId: conversationId },
                )
              }
              className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 text-xs text-ink-muted hover:text-ink"
              title={
                (conv.workspaceAgentMemberIds?.length ?? 0) > 0
                  ? 'Review each project and merge independently'
                  : `View diff · rebase / merge / push / PR (${conv.branchName} → ${conv.baseBranch ?? 'main'})`
              }
            >
              <DiffIcon />
              <span>Diff</span>
            </button>
          )
        )}

        {backend !== 'ollama' &&
          (() => {
            const cwd = conv.worktreePath ?? findOwningProjectPath(projects, conversationId);
            if (!cwd) return null;
            return (
              <IconButton
                onClick={async () => {
                  const res = await window.overcli.invoke('terminal:popConversation', {
                    cwd,
                    backend,
                    sessionId: conv.sessionId,
                  });
                  if (!res.ok) window.alert(res.error);
                }}
                title={`Pop to Terminal in ${cwd}${conv.sessionId ? ` · resume ${backendName(backend)}` : ''}`}
              >
                <TerminalIcon />
              </IconButton>
            );
          })()}

        <ConversationSettingsButton
          conversationId={conversationId}
          locked={locked}
          onModelChange={(b, m) => void setModel(conversationId, b, m)}
        />

        <MoreMenu
          onReset={() => setConfirmingReset(true)}
          onArchive={() =>
            openSheet({ type: 'archiveConversation', convId: conversationId })
          }
          onRevealInFinder={() => {
            const p = conv.worktreePath;
            if (p) window.overcli.invoke('fs:openInFinder', p);
          }}
          worktreeAvailable={!!conv.worktreePath}
        />

        {confirmingReset && (
          <div className="flex items-center gap-1 ml-1">
            <span className="text-xs text-ink-muted">Reset?</span>
            <button
              onClick={() => {
                void resetConversation(conversationId);
                setConfirmingReset(false);
              }}
              className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
            >
              Reset
            </button>
            <button
              onClick={() => setConfirmingReset(false)}
              className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function HeaderBadge({
  children,
  title,
  style,
  pulse,
}: {
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
  pulse?: boolean;
}) {
  return (
    <span
      title={title}
      style={style}
      className={
        'shrink-0 rounded-full border border-card bg-card px-2 py-0.5 text-[10px] font-medium' +
        (pulse ? ' animate-pulse' : '')
      }
    >
      {children}
    </span>
  );
}

function BackendDot({ color }: { color: string }) {
  return (
    <span
      className="w-2 h-2 rounded-full"
      style={{ background: color }}
    />
  );
}

/// Used for permission tone (amber for acceptEdits, red for bypass, etc.)
function ShieldIcon({ tone }: { tone?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L13 3.5v4c0 3-2 5.5-5 7-3-1.5-5-4-5-7v-4L8 1.5z"
        stroke={tone ?? 'currentColor'}
        strokeWidth="1.2"
      />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M5.5 3a2 2 0 012-2c1 0 1.8.7 2 1.6.3-.4.8-.6 1.3-.6a2 2 0 012 2c0 .3-.1.6-.2.8a2 2 0 01-.3 3.8 2 2 0 01-2.8 2A2 2 0 018 12c-.5 0-1 -.2-1.3-.5A2 2 0 013.5 9.6 2 2 0 012.7 6a2 2 0 01.3-3.8A2 2 0 015.5 3z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1 8s2.5-5 7-5c1.3 0 2.4.4 3.3.9" stroke="currentColor" strokeWidth="1.2" />
      <path d="M15 8s-2.5 5-7 5c-1.3 0-2.4-.4-3.3-.9" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="15" x2="15" y2="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3l1 1.5h6A1 1 0 0113.5 6v6A1 1 0 0112.5 13h-10A1 1 0 011.5 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function ReboundIcon({ tint }: { tint?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 8 L8 4 L12 8 M8 4 V13 M13 13 H3"
        stroke={tint ?? 'currentColor'}
        strokeWidth="1.2"
      />
    </svg>
  );
}

function IconButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'w-7 h-7 flex items-center justify-center rounded ' +
        (active
          ? 'bg-accent/20 text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink')
      }
    >
      {children}
    </button>
  );
}

interface PickerItem {
  value: string;
  label: string;
  disabled?: boolean;
  note?: string;
  leading?: React.ReactNode;
}

function IconPicker({
  icon,
  label,
  items,
  onPick,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  items: PickerItem[];
  onPick: (v: string) => void;
  tone?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-card-strong"
        style={tone ? { color: tone } : undefined}
      >
        {icon}
        <span className="text-xs">{label}</span>
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[200px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 py-1">
          {items.map((it) => (
            <button
              key={it.value}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                onPick(it.value);
              }}
              className={
                'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ' +
                (it.disabled
                  ? 'text-ink-faint cursor-not-allowed'
                  : 'text-ink-muted hover:bg-card-strong hover:text-ink')
              }
            >
              {it.leading}
              <span className="flex-1">{it.label}</span>
              {it.note && <span className="text-[10px] text-amber-400">{it.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// Fork picker: creates a sibling conversation in the same project,
/// optionally targeting a different backend. Designed for the case where
/// a CLI is down or rate-limited and the user wants to continue the same
/// line of thought on a different one. The prior transcript is packaged
/// into a one-shot preamble that's prepended to the fork's first send,
/// and the last user prompt becomes the fork's draft so it's one click
/// away from being re-sent.
function ForkPicker({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const backendHealth = useStore((s) => s.backendHealth);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const newConversation = useStore((s) => s.newConversation);
  const newConversationInWorkspace = useStore((s) => s.newConversationInWorkspace);
  const selectConversation = useStore((s) => s.selectConversation);
  const setPrimary = useStore((s) => s.setPrimaryBackend);
  const setDraft = useStore((s) => s.setDraft);
  const runners = useStore((s) => s.runners);
  if (!conv) return null;
  const ownerProject = projects.find((p) => p.conversations.some((c) => c.id === conversationId));
  const ownerWorkspace = ownerProject
    ? undefined
    : workspaces.find((w) => (w.conversations ?? []).some((c) => c.id === conversationId));
  const currentBackend = conv.primaryBackend ?? (enabledBackends(settings)[0] ?? 'claude');

  const sourceEvents = runners[conversationId]?.events ?? [];
  const lastUserPrompt = (() => {
    for (let i = sourceEvents.length - 1; i >= 0; i--) {
      const e = sourceEvents[i];
      if (e.kind.type === 'localUser') return e.kind.text;
    }
    return '';
  })();

  const forkTo = async (targetBackend: Backend) => {
    if (!ownerProject && !ownerWorkspace) return;
    const { preamble, turnCount } = buildForkPreamble(sourceEvents, lastUserPrompt);
    const forked = ownerProject
      ? await newConversation(ownerProject.id)
      : await newConversationInWorkspace(ownerWorkspace!.id);
    if (!forked) return;
    // Rename to make the relationship obvious in the sidebar, and stash
    // the prior-transcript preamble on the conv so `send` can ship it on
    // the very first turn (then clear it).
    const patch = (c: Conversation) =>
      c.id === forked.id
        ? {
            ...c,
            name: `${conv.name} (fork → ${backendName(targetBackend)})`,
            forkPreamble: preamble || undefined,
          }
        : c;
    useStore.setState((s) => ({
      projects: ownerProject
        ? s.projects.map((p) =>
            p.id === ownerProject.id ? { ...p, conversations: p.conversations.map(patch) } : p,
          )
        : s.projects,
      workspaces: ownerWorkspace
        ? s.workspaces.map((w) =>
            w.id === ownerWorkspace.id
              ? { ...w, conversations: (w.conversations ?? []).map(patch) }
              : w,
          )
        : s.workspaces,
    }));
    await setPrimary(forked.id, targetBackend);
    if (lastUserPrompt) setDraft(forked.id, lastUserPrompt);
    // Drop a system notice into the new conversation so the user can see
    // what was carried over (and that anything beyond the cap was trimmed).
    if (turnCount > 0) {
      const notice =
        turnCount === 1
          ? `Forked from "${conv.name}" — attaching 1 prior turn as context on the first message.`
          : `Forked from "${conv.name}" — attaching ${turnCount} prior turn${turnCount === 1 ? '' : 's'} as context on the first message.`;
      useStore.setState((s) => {
        const runner = s.runners[forked.id] ?? {
          events: [],
          isRunning: false,
          pendingLocalUserIds: new Set<UUID>(),
          currentModel: '',
          historyLoaded: false,
          historyLoading: false,
        };
        return {
          runners: {
            ...s.runners,
            [forked.id]: {
              ...runner,
              events: [
                ...runner.events,
                {
                  id: `fork-notice-${forked.id}`,
                  timestamp: Date.now(),
                  raw: '',
                  kind: { type: 'systemNotice', text: notice },
                  revision: 0,
                },
              ],
            },
          },
        };
      });
    }
    selectConversation(forked.id);
  };

  const items: PickerItem[] = enabledBackends(settings).map((b) => ({
    value: b,
    label:
      b === currentBackend
        ? `${backendName(b)} (same backend)`
        : `Fork to ${backendName(b)}`,
    leading: <BackendDot color={backendColor(b)} />,
    disabled: backendHealth[b]?.kind !== 'ready',
    note: backendHealth[b]?.kind === 'unauthenticated' ? 'auth needed' : undefined,
  }));

  return (
    <IconPicker
      icon={<ForkIcon />}
      label="fork"
      items={items}
      onPick={(v) => void forkTo(v as Backend)}
    />
  );
}

/// Cap for the prior-transcript blob we ship with a fork's first turn.
/// ~20 KB ≈ a few thousand tokens — enough to re-seat context without
/// blowing the target CLI's window (which can already be close to full
/// on a long parent conversation). Old turns trim first; the most recent
/// exchanges are what usually matter for the follow-up.
const FORK_PREAMBLE_MAX_CHARS = 20_000;
const FORK_ASSISTANT_CHAR_CAP = 2_400;

function truncateForPreamble(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + ' …[truncated]';
}

/// Walk the source conversation's events into (user, assistant) pairs and
/// serialize them into a single preamble string, newest turns first in the
/// budget. The *last* user prompt is dropped from the preamble — it will
/// be sent as the fork's first real message, so including it here would
/// duplicate it and confuse the model.
function buildForkPreamble(
  events: StreamEvent[],
  lastUserPrompt: string,
): { preamble: string; turnCount: number } {
  type Turn = { user: string; assistant: string };
  const turns: Turn[] = [];
  let pendingUser: string | null = null;
  for (const e of events) {
    if (e.kind.type === 'localUser') {
      if (pendingUser !== null) {
        turns.push({ user: pendingUser, assistant: '' });
      }
      pendingUser = e.kind.text;
    } else if (e.kind.type === 'assistant' && e.kind.info.text.trim()) {
      if (pendingUser !== null) {
        turns.push({ user: pendingUser, assistant: e.kind.info.text });
        pendingUser = null;
      } else if (turns.length > 0) {
        const last = turns[turns.length - 1];
        last.assistant = last.assistant
          ? `${last.assistant}\n\n${e.kind.info.text}`
          : e.kind.info.text;
      }
    }
  }
  // Drop the dangling user turn that matches the draft we're about to send.
  while (turns.length > 0) {
    const tail = turns[turns.length - 1];
    if (!tail.assistant && tail.user.trim() === lastUserPrompt.trim()) {
      turns.pop();
    } else {
      break;
    }
  }
  if (turns.length === 0) return { preamble: '', turnCount: 0 };

  const header =
    'Prior conversation from a sibling CLI (for context only — do not repeat work already done):\n\n';
  const budget = FORK_PREAMBLE_MAX_CHARS - header.length - 64; // headroom for separators/marker
  const rendered: string[] = [];
  let used = 0;
  let trimmedOlder = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const chunk =
      `User: ${truncateForPreamble(t.user, FORK_ASSISTANT_CHAR_CAP)}` +
      (t.assistant
        ? `\n\nAssistant: ${truncateForPreamble(t.assistant, FORK_ASSISTANT_CHAR_CAP)}`
        : '');
    const sepCost = rendered.length > 0 ? 7 : 0; // "\n\n---\n\n"
    if (used + chunk.length + sepCost > budget) {
      trimmedOlder = i > 0 || !trimmedOlder;
      break;
    }
    rendered.unshift(chunk);
    used += chunk.length + sepCost;
  }
  const includedCount = rendered.length;
  if (includedCount === 0) return { preamble: '', turnCount: 0 };
  const body = rendered.join('\n\n---\n\n');
  const prefix = trimmedOlder ? '[earlier turns omitted for length]\n\n' : '';
  return { preamble: `${header}${prefix}${body}`, turnCount: includedCount };
}

function ForkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 4.5 V7 Q4 9 6.5 10 L8 11 M12 4.5 V7 Q12 9 9.5 10 L8 11" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

/// Anchored popover for the rebound feature. Rebound runs a *second* CLI
/// after every primary turn — either as a one-shot reviewer ("what do you
/// think of this response?") or as a ping-pong collab loop. The popover
/// presents those as two separate decisions — pick a reviewer backend,
/// pick a mode — instead of cramming backend+mode into one dropdown
/// line which was hard to scan.
function ReboundPicker({
  conv,
  installedReviewers,
  onSelectBackend,
  onSelectMode,
  onSelectOllamaModel,
  onToggleYolo,
}: {
  conv: {
    id: UUID;
    reviewBackend?: string | null;
    reviewMode?: 'review' | 'collab' | null;
    collabMaxTurns?: number | null;
    reviewOllamaModel?: string | null;
    reviewYolo?: boolean | null;
    primaryBackend?: Backend;
  };
  installedReviewers: Record<string, boolean>;
  onSelectBackend: (b: string | null) => void;
  onSelectMode: (m: 'review' | 'collab') => void;
  onSelectOllamaModel: (m: string | null) => void;
  onToggleYolo: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pulled, setPulled] = useState<string[]>([]);
  const settings = useStore((s) => s.settings);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Load pulled Ollama models whenever the popover opens so the model
  // picker below can show one-click choices.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.overcli.invoke('ollama:detect').then((det) => {
      if (cancelled) return;
      setPulled(det.models.map((m) => m.name));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const active = !!conv.reviewBackend;
  const tint = active ? '#c29bff' : undefined;
  const primary = conv.primaryBackend ?? (enabledBackends(settings)[0] ?? 'claude');
  const candidates = enabledBackends(settings).filter((b) => b !== primary);

  const label = active
    ? `rebound · ${conv.reviewBackend}${conv.reviewMode === 'collab' ? ' · collab' : ''}`
    : 'rebound';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-card-strong"
        style={tint ? { color: tint } : undefined}
      >
        <ReboundIcon tint={tint} />
        <span className="text-xs">{label}</span>
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[300px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">Reviewer</div>
            <div className="flex flex-col gap-1">
              <ReboundRow
                label="Off"
                description="No secondary review."
                selected={!active}
                onSelect={() => onSelectBackend(null)}
              />
              {candidates.map((b) => {
                const ready = installedReviewers[b];
                const isLocal = b === 'ollama';
                return (
                  <ReboundRow
                    key={b}
                    label={backendName(b) + (isLocal ? '  (local)' : '')}
                    labelColor={backendColor(b)}
                    description={
                      ready
                        ? isLocal
                          ? `Fast, private, but lighter-weight critique than Claude/Codex. Uses your default Ollama model.`
                          : `Run ${backendName(b)} after each ${backendName(primary)} turn.`
                        : isLocal
                        ? 'Ollama not installed — set it up in the Local tab.'
                        : `${backendName(b)} CLI not installed or not authenticated.`
                    }
                    selected={conv.reviewBackend === b}
                    disabled={!ready}
                    onSelect={() => onSelectBackend(b)}
                  />
                );
              })}
            </div>
          </div>

          {active && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">Mode</div>
              <div className="flex flex-col gap-1">
                <ReboundRow
                  label="Review"
                  description="One-shot: reviewer reads each turn and comments."
                  selected={conv.reviewMode !== 'collab'}
                  onSelect={() => onSelectMode('review')}
                />
                <ReboundRow
                  label="Collab"
                  description="Ping-pong: primary and reviewer take turns until the budget is spent."
                  selected={conv.reviewMode === 'collab'}
                  onSelect={() => onSelectMode('collab')}
                />
              </div>
            </div>
          )}

          {active && conv.reviewBackend === 'ollama' && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
                Ollama model
              </div>
              {pulled.length === 0 ? (
                <div className="text-[10px] text-amber-400">
                  No models pulled. Open the Local tab to pull one.
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <button
                    onClick={() => onSelectOllamaModel(null)}
                    className={
                      'text-left px-2 py-1 rounded font-mono text-[11px] ' +
                      (!conv.reviewOllamaModel
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                    }
                  >
                    (use default)
                  </button>
                  {pulled.map((m) => (
                    <button
                      key={m}
                      onClick={() => onSelectOllamaModel(m)}
                      className={
                        'text-left px-2 py-1 rounded font-mono text-[11px] ' +
                        (conv.reviewOllamaModel === m
                          ? 'bg-accent/15 text-ink'
                          : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                      }
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {active && conv.reviewMode === 'collab' && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
                Collab rounds per burst
              </div>
              <CollabRoundsInput conversationId={conv.id} />
              <div className="text-[10px] text-ink-faint mt-1">
                Max back-and-forth turns before we stop and return to you.
              </div>
            </div>
          )}

          {active && conv.reviewBackend === 'codex' && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
                Codex sandbox
              </div>
              <label className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-card-strong cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!conv.reviewYolo}
                  onChange={(e) => onToggleYolo(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="flex flex-col">
                  <span className="text-xs">Yolo mode</span>
                  <span className="text-[10px] text-ink-faint">
                    Workspace-write + auto-approve. Off = codex's default read-only sandbox.
                  </span>
                </div>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReboundRow({
  label,
  labelColor,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  labelColor?: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onSelect}
      className={
        'w-full text-left px-2 py-1.5 rounded flex items-start gap-2 ' +
        (selected
          ? 'bg-accent/15 ring-1 ring-accent/30'
          : disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-card-strong')
      }
    >
      <div className="mt-0.5">
        {selected ? (
          <div className="w-3 h-3 rounded-full border-2 border-accent bg-accent" />
        ) : (
          <div className="w-3 h-3 rounded-full border border-card-strong" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={selected ? 'text-ink' : 'text-ink-muted'}
          style={labelColor ? { color: labelColor } : undefined}
        >
          {label}
        </div>
        <div className="text-[10px] text-ink-faint">{description}</div>
      </div>
    </button>
  );
}

function CollabRoundsInput({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const setRounds = (v: number) =>
    useStore.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        conversations: p.conversations.map((c) =>
          c.id === conversationId ? { ...c, collabMaxTurns: v } : c,
        ),
      })),
    }));
  // Default 3 pongs — the Swift build found that deeper collab loops
  // burned a lot of tokens without meaningfully improving the result.
  const v = conv?.collabMaxTurns ?? 3;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={2}
        max={20}
        step={1}
        value={v}
        onChange={(e) => setRounds(parseInt(e.target.value, 10))}
        className="flex-1 accent-accent"
      />
      <span className="text-[10px] text-ink w-6 text-right">{v}</span>
    </div>
  );
}

function ConversationSettingsButton({
  conversationId,
  locked,
  onModelChange,
}: {
  conversationId: UUID;
  locked: boolean;
  onModelChange: (backend: Backend, model: string) => void;
}) {
  const conv = useConversation(conversationId);
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [ollamaPulled, setOllamaPulled] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const backend: Backend = conv?.primaryBackend ?? (enabledBackends(settings)[0] ?? 'claude');

  // Fetch the list of pulled Ollama models whenever the popover opens on
  // an Ollama conversation — gives the user one-click picks instead of
  // having to remember `qwen2.5-coder:14b-instruct-q4_K_M`.
  useEffect(() => {
    if (!open || backend !== 'ollama') return;
    let cancelled = false;
    void window.overcli.invoke('ollama:detect').then((det) => {
      if (cancelled) return;
      setOllamaPulled(det.models.map((m) => m.name));
    });
    return () => {
      cancelled = true;
    };
  }, [open, backend]);

  if (!conv) return null;
  const current =
    backend === 'claude'
      ? conv.claudeModel ?? ''
      : backend === 'codex'
      ? conv.codexModel ?? ''
      : backend === 'ollama'
      ? conv.ollamaModel ?? ''
      : conv.geminiModel ?? '';
  return (
    <div ref={ref} className="relative">
      <IconButton active={open} onClick={() => setOpen((o) => !o)} title="Conversation settings">
        <SlidersIcon />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[280px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">Model override</div>
          <input
            value={current}
            onChange={(e) => onModelChange(backend, e.target.value)}
            placeholder={settings.backendDefaultModels[backend] ?? '(default)'}
            className="field px-2 py-1 font-mono text-[11px]"
          />
          {backend === 'ollama' && ollamaPulled.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[10px] uppercase tracking-wider text-ink-faint mt-1">Pulled locally</div>
              {ollamaPulled.map((m) => (
                <button
                  key={m}
                  onClick={() => onModelChange(backend, m)}
                  className={
                    'text-left px-2 py-1 rounded font-mono text-[11px] ' +
                    (current === m ? 'bg-accent/15 text-ink' : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                  }
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          {backend === 'ollama' && ollamaPulled.length === 0 && (
            <div className="text-[10px] text-amber-400">
              No models pulled. Open the Local tab to pull one.
            </div>
          )}
          <div className="text-[10px] text-ink-faint">
            Leave blank to use the app's default model for {backend}.
          </div>
          {locked && (
            <div className="text-[10px] text-amber-400">
              Session already started — model changes apply to the next turn.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// One-click commit for the conversation's cwd. Hides itself when the
/// cwd isn't a git working tree (git missing, not a repo, etc.) so the
/// header stays clean for non-git projects. Always `git add -A` + commit —
/// no partial staging, no push. Pushing is one decision too far for a
/// single header button; the worktree Diff sheet handles that case.
function CommitButton({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const projects = useStore((s) => s.projects);
  const gitStatus = useStore((s) => s.gitStatusByConv[conversationId]);
  const refreshGitStatus = useStore((s) => s.refreshGitStatus);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [messageEdited, setMessageEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successSubject, setSuccessSubject] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const prevStatsRef = useRef<{ insertions: number; deletions: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const cwd = conv?.worktreePath ?? findOwningProjectPath(projects, conversationId) ?? null;
  const isRepo = gitStatus?.isRepo ?? false;
  const currentBranch = gitStatus?.currentBranch ?? '';
  const changes = gitStatus?.changes ?? [];
  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;

  // Flash the +/- badge whenever the numbers change (other than on the
  // initial probe). Bumping flashKey remounts the span so the CSS
  // animation replays from the start.
  useEffect(() => {
    const prev = prevStatsRef.current;
    if (!prev) {
      prevStatsRef.current = { insertions, deletions };
      return;
    }
    if (prev.insertions === insertions && prev.deletions === deletions) return;
    prevStatsRef.current = { insertions, deletions };
    setFlashKey((k) => k + 1);
  }, [insertions, deletions]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Re-probe and seed a draft message every time the popover opens so the
  // user sees the current state + a fresh suggestion, not whatever was
  // there five minutes ago.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccessSubject(null);
    void refreshGitStatus(conversationId).then(() => {
      // Seed draft only if the user hasn't typed their own — preserves
      // in-progress edits when they accidentally click outside.
      if (!messageEdited) {
        setMessage(draftCommitMessage(changes));
      }
    });
    // We intentionally don't add `changes` / `messageEdited` to deps —
    // the draft seeds on popover-open only, not on every state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId, refreshGitStatus]);

  if (!isRepo) return null;

  const hasChanges = changes.length > 0;

  const onCommit = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    setError(null);
    const res = await window.overcli.invoke('git:commitAll', { cwd, message });
    setBusy(false);
    if (res.ok) {
      setSuccessSubject(res.subject);
      setMessageEdited(false);
      setMessage('');
      await refreshGitStatus(conversationId);
    } else {
      setError(res.error);
    }
  };

  const diffstatTitle = hasChanges
    ? `Commit · ${changes.length} file${changes.length === 1 ? '' : 's'} · +${insertions} −${deletions}`
    : 'Working tree clean';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={diffstatTitle}
        className={
          'h-7 px-1.5 flex items-center gap-1.5 rounded text-ink-muted hover:bg-card-strong hover:text-ink ' +
          (open ? 'bg-accent/20 text-ink' : '')
        }
      >
        <CommitIcon />
        {hasChanges && (
          <span
            key={flashKey}
            className={
              'flex items-center gap-1 text-[10px] font-mono leading-none ' +
              (flashKey > 0 ? 'git-stats-flash' : '')
            }
          >
            <span className="diff-add-ink">+{insertions}</span>
            <span className="diff-remove-ink">−{deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[340px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint">Commit</div>
            {currentBranch && (
              <div className="text-[10px] font-mono text-ink-faint truncate max-w-[180px]" title={currentBranch}>
                ⎇ {currentBranch}
              </div>
            )}
          </div>

          {successSubject ? (
            <div className="text-[11px] text-emerald-400">
              Committed: <span className="font-mono">{successSubject}</span>
            </div>
          ) : !hasChanges ? (
            <div className="text-[11px] text-ink-muted">Working tree clean — nothing to commit.</div>
          ) : (
            <>
              <div className="rounded border border-card bg-card px-2 py-1.5 text-[10px] font-mono text-ink-muted max-h-[96px] overflow-y-auto">
                {changes.slice(0, 30).map((c) => (
                  <div key={c.path} className="truncate" title={c.path}>
                    <span className="text-ink-faint mr-1.5">{c.status.trim() || '??'}</span>
                    {c.path}
                  </div>
                ))}
                {changes.length > 30 && (
                  <div className="text-ink-faint">… {changes.length - 30} more</div>
                )}
              </div>
              <textarea
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setMessageEdited(true);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (!busy && message.trim()) void onCommit();
                  }
                }}
                placeholder={`Commit message (${shortcutLabel()} to commit)`}
                rows={3}
                className="field px-2 py-1.5 text-[11px] leading-5 resize-none"
                autoFocus
              />
              <div className="text-[10px] text-ink-faint">
                Runs <span className="font-mono">git add -A</span> then{' '}
                <span className="font-mono">git commit</span>. Push separately from the Diff sheet.
              </div>
            </>
          )}

          {error && <div className="text-[11px] text-red-400 whitespace-pre-wrap">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setOpen(false)}
              className="text-[11px] px-2 py-1 rounded text-ink-muted hover:text-ink"
            >
              Close
            </button>
            <div className="flex-1" />
            {hasChanges && !successSubject && (
              <button
                onClick={onCommit}
                disabled={busy || !message.trim()}
                className={
                  'text-xs px-3 py-1.5 rounded border flex items-center gap-2 ' +
                  (busy || !message.trim()
                    ? 'bg-card text-ink-faint border-card cursor-not-allowed'
                    : 'bg-accent/20 text-ink border-accent/40 hover:bg-accent/30')
                }
              >
                <span>{busy ? 'Committing…' : 'Commit'}</span>
                {!busy && (
                  <span className="text-xs text-ink-muted">{shortcutLabel()}</span>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// Simple draft: one file → "Update <basename>". Files all under one
/// directory → "Update <dir>". Otherwise a file count. Intentionally
/// dumb — anything smarter would need to read the diff, which is more
/// work than drafting-from-scratch is worth.
/// OS-aware label for the commit submit shortcut. Mac gets the native
/// ⌘ glyph + the word "Return" (the ⏎ / ↵ Unicode chars render
/// inconsistently in most mono/sans stacks and look visually wrong at
/// small sizes). Other platforms get the fully spelled form.
function shortcutLabel(): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  return isMac ? '⌘ Return' : 'Ctrl + Enter';
}

function draftCommitMessage(changes: Array<{ path: string }>): string {
  if (changes.length === 0) return '';
  if (changes.length === 1) {
    const name = changes[0].path.split('/').pop() || changes[0].path;
    return `Update ${name}`;
  }
  const dirs = new Set(
    changes.map((c) => {
      const parts = c.path.split('/');
      return parts.length > 1 ? parts[0] : '.';
    }),
  );
  if (dirs.size === 1) {
    const only = Array.from(dirs)[0];
    return only === '.' ? `Update ${changes.length} files` : `Update ${only}`;
  }
  return `Update ${changes.length} files`;
}

function CommitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <line x1="1.5" y1="8" x2="5" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="11" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function stripOriginPrefix(branch: string): string {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
}

function ReviewAgentActions({
  conversationId,
  targetBranch,
  hasWorktree,
  kind,
  onPromote,
  onCheckoutLocally,
  onDismiss,
}: {
  conversationId: UUID;
  targetBranch: string;
  hasWorktree: boolean;
  kind: 'review' | 'docs';
  onPromote: () => Promise<void>;
  onCheckoutLocally: () => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const short = stripOriginPrefix(targetBranch);
  const label = kind === 'docs' ? 'Docs' : 'Review';
  const GlyphIcon = kind === 'docs' ? DocsIcon : EyeIcon;
  const dismissHint = hasWorktree
    ? 'Remove the worktree and delete the conversation.'
    : 'Delete the conversation.';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-card-strong text-xs text-ink-muted hover:text-ink"
        title={hasWorktree ? `${label} actions for ${short}` : `${label} actions`}
        data-conv={conversationId}
      >
        <GlyphIcon />
        <span>{label}</span>
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[280px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 py-1 text-xs">
          {hasWorktree && (
            <>
              <ReviewMenuRow
                label="Promote to working agent"
                hint="Keep the worktree, create a branch, and drop the read-only framing so the agent can start making changes."
                onClick={() => void run(onPromote)}
                disabled={busy}
              />
              <ReviewMenuRow
                label={`Check out ${short} locally`}
                hint="Remove the worktree and switch your main project repo onto this branch. WIP will be auto-stashed."
                onClick={() => void run(onCheckoutLocally)}
                disabled={busy}
              />
              <div className="border-t border-card my-1" />
            </>
          )}
          <ReviewMenuRow
            label={kind === 'docs' ? 'Dismiss docs agent' : 'Dismiss review'}
            hint={dismissHint}
            onClick={() => void run(onDismiss)}
            disabled={busy}
            danger
          />
        </div>
      )}
    </div>
  );
}

function ReviewMenuRow({
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'w-full text-left px-3 py-1.5 hover:bg-card-strong disabled:opacity-40 disabled:cursor-not-allowed ' +
        (danger ? 'text-red-400 hover:text-red-300' : 'text-ink-muted hover:text-ink')
      }
    >
      <div>{label}</div>
      <div className="text-[10px] text-ink-faint mt-0.5 leading-snug">{hint}</div>
    </button>
  );
}

function DiffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 2v4H2l3 3 3-3H6V2H4zm6 3 3 3h-2v4h-2V8H7l3-3z"
        fill="currentColor"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 6l2.5 2L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <line x1="2" y1="4" x2="9" y2="4" stroke="currentColor" strokeWidth="1.2" />
      <line x1="11" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="4" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <line x1="2" y1="8" x2="5" y2="8" stroke="currentColor" strokeWidth="1.2" />
      <line x1="7" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="8" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <line x1="2" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.2" />
      <line x1="12" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="12" r="1.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function MoreMenu({
  onReset,
  onArchive,
  onRevealInFinder,
  worktreeAvailable,
}: {
  onReset: () => void;
  onArchive: () => void;
  onRevealInFinder: () => void;
  worktreeAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton active={open} onClick={() => setOpen((o) => !o)} title="More">
        <span className="text-[14px] leading-none">⋯</span>
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[220px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 py-1 text-xs">
          <MenuRow
            label="Reset conversation"
            onClick={() => {
              setOpen(false);
              onReset();
            }}
          />
          {worktreeAvailable && (
            <MenuRow
              label="Reveal worktree in Finder"
              onClick={() => {
                setOpen(false);
                onRevealInFinder();
              }}
            />
          )}
          <div className="border-t border-card my-1" />
          <MenuRow
            label="Rename, archive, or delete…"
            onClick={() => {
              setOpen(false);
              onArchive();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuRow({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-3 py-1.5 hover:bg-card-strong ' +
        (danger ? 'text-red-400 hover:text-red-300' : 'text-ink-muted hover:text-ink')
      }
    >
      {label}
    </button>
  );
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'acceptEdits':
      return 'Accept edits';
    case 'bypassPermissions':
      return 'Bypass (dangerous)';
    default:
      return 'Default';
  }
}

function permissionTone(mode: PermissionMode): string | undefined {
  if (mode === 'bypassPermissions') return '#f97a5a';
  if (mode === 'acceptEdits') return '#f7b267';
  return undefined;
}

function effortLabel(effort: EffortLevel): string {
  if (!effort) return 'Effort';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function isBackendEnabled(
  settings: { disabledBackends?: Partial<Record<Backend, boolean>> },
  backend: Backend,
): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

function enabledBackends(settings: { disabledBackends?: Partial<Record<Backend, boolean>> }): Backend[] {
  const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  return all.filter((b) => isBackendEnabled(settings, b));
}

function DocsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 2.5h5l3 3v8A1 1 0 0 1 11 14.5H4A1 1 0 0 1 3 13.5v-10A1 1 0 0 1 4 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 2.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
