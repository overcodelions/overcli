import { useEffect, useMemo, useRef, useState } from 'react';
import {
  backendHealthLoaded,
  noBackendReady,
  setPendingNewConversation,
  useStore,
} from '../store';
import { useFlowsStore } from '../flowsStore';
import { Composer } from './Composer';
import { createBranchedAgent, createDetachedAgent } from './sheets/NewAgentSheet';
import { BranchCombobox } from './sheets/BranchCombobox';
import { useProjectBranches } from './sheets/useProjectBranches';
import { FlowCard, RunPanel } from './flows/FlowLaunch';
import { BrowseLibraryModal } from './flows/BrowseLibraryModal';
import { CopyButton } from './ManualCommand';
import { ProjectFilesBubble } from './ProjectFilesBubble';
import { ResumeRow } from './ResumeRow';
import { isEverydayProject } from '@shared/everydayProjects';
import {
  flowTagCounts,
  groupFlows,
  installedRegistryKeys,
  registryEntryMatchesQuery,
} from './flows/flowGrouping';
import {
  Backend,
  BackendHealth,
  PermissionMode,
  EffortLevel,
  Project,
  ReviewPreset,
  UUID,
  Attachment,
  Workspace,
  FlowRegistryEntry,
} from '@shared/types';
import { PERSONA_REQUIRES_CODE_CHANGES, PRESETS, TIERS, modelTier, resolvePreset } from '@shared/reboundPresets';
import { PREMIUM_MODELS } from '@shared/modelCatalog';
import { pathBasename } from '@shared/workspaceNames';
import { effortForBackend } from '@shared/effort';
import { flowStarKey, type Flow } from '@shared/flows/schema';
import { backendColor, backendName, shortModel } from '../theme';
import { useSlashCommands } from '../hooks';
import {
  effortLabel,
  enabledBackends,
  isBackendEnabled,
  modeLabel,
  permissionTone,
  pickDefaultBackend,
} from './conversationHeaderHelpers';

const WELCOME_KEY = '__welcome__';

/// How a send from the start page runs: in the project directory, in a
/// fresh build worktree, or in a detached read-only worktree at another
/// branch's tip (review / docs).
type RunMode = 'local' | 'agent' | 'review' | 'docs';

/// Composer-first start page. Modeled on the reference screenshot the user
/// shared: a centered prompt + big input, with pills for model/effort/mode
/// inside the composer and project/env/branch below it. Sending from here
/// creates a new conversation and hands the draft + attachments off.
export function WelcomePane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const settings = useStore((s) => s.settings);
  const installedReviewers = useStore((s) => s.installedReviewers);
  const backendHealth = useStore((s) => s.backendHealth);
  const focusedProjectId = useStore((s) => s.focusedProjectId);
  const focusedWorkspaceId = useStore((s) => s.focusedWorkspaceId);
  const welcomeFocusToken = useStore((s) => s.welcomeFocusToken);
  const pickProject = useStore((s) => s.pickProject);
  const newConversation = useStore((s) => s.newConversation);
  const newConversationInWorkspace = useStore((s) => s.newConversationInWorkspace);
  const startNewConversation = useStore((s) => s.startNewConversation);
  const startNewConversationInWorkspace = useStore((s) => s.startNewConversationInWorkspace);
  const send = useStore((s) => s.send);
  const setBackendModel = useStore((s) => s.setBackendModel);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const setEffortLevel = useStore((s) => s.setEffortLevel);
  const setPrimaryBackend = useStore((s) => s.setPrimaryBackend);
  const setReviewPreset = useStore((s) => s.setReviewPreset);
  const addAttachment = useStore((s) => s.addAttachment);
  const clearAttachments = useStore((s) => s.clearAttachments);
  const setDraft = useStore((s) => s.setDraft);
  const openSheet = useStore((s) => s.openSheet);
  const selectConversation = useStore((s) => s.selectConversation);
  const saveProjects = useStore((s) => s.saveProjects);
  const newWorkspaceAgent = useStore((s) => s.newWorkspaceAgent);

  const focusedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === focusedWorkspaceId) ?? null,
    [workspaces, focusedWorkspaceId],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<UUID | null>(
    () => focusedProjectId ?? projects[0]?.id ?? null,
  );
  // Local nudge added to the global welcomeFocusToken so we can re-focus
  // the composer after the user clicks a starter prompt chip without
  // mutating store-level state.
  const [composerFocusNudge, setComposerFocusNudge] = useState(0);
  const [backend, setBackend] = useState<Backend>(() =>
    pickDefaultBackend(settings, backendHealth),
  );
  // Once the user picks from the backend pill, that choice is theirs — the
  // health-driven re-seed below stops second-guessing it.
  const [backendPicked, setBackendPicked] = useState(false);
  const [permissionMode, setLocalPermissionMode] = useState<PermissionMode>(
    settings.defaultPermissionMode,
  );
  const [effort, setEffort] = useState<EffortLevel>(effortForBackend(settings, backend));
  // Same bargain as `backendPicked`: effort follows the chosen backend's
  // default until the user states a preference, then it's theirs to keep.
  const [effortPicked, setEffortPicked] = useState(false);
  const [model, setModel] = useState<string>('');
  const [reviewPreset, setLocalReviewPreset] = useState<ReviewPreset | 'off'>('off');
  const [branch, setBranch] = useState<string>('');
  // 'local' chats in the project directory; 'agent' mints an isolated git
  // worktree on a fresh branch (same wiring as the sidebar "+ agent"),
  // letting background work stay off the working checkout. 'review' and
  // 'docs' are the read-only kinds from the "+ agent" sheet — a detached
  // worktree at some other branch's tip — offered here so you don't have
  // to leave the composer to review a branch.
  const [runMode, setRunMode] = useState<RunMode>('local');
  const [targetBranch, setTargetBranch] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  // Live worktree-creation status. Workspace agents mint one worktree per
  // member repo, which can take a few seconds, so we surface progress.
  const [agentProgress, setAgentProgress] = useState<string | null>(null);
  const creatingAgent = useRef(false);
  const [ollamaPulledModels, setOllamaPulledModels] = useState<string[]>([]);
  const slashCommands = useSlashCommands(backend);

  // When Ollama is the chosen backend, pull the list of installed models
  // from the local server so the model dropdown shows real options
  // instead of hardcoded guesses. Also auto-pick a default so users
  // don't have to open the dropdown: prefer the configured default if
  // they set one, else the first pulled model.
  useEffect(() => {
    if (backend !== 'ollama') return;
    let cancelled = false;
    void window.overcli.invoke('ollama:detect').then((det) => {
      if (cancelled) return;
      const names = det.models.map((m) => m.name);
      setOllamaPulledModels(names);
      setModel((current) => {
        if (current && names.includes(current)) return current;
        const configured = settings.backendDefaultModels.ollama;
        if (configured && names.includes(configured)) return configured;
        return names[0] ?? '';
      });
    });
    return () => {
      cancelled = true;
    };
  }, [backend, settings.backendDefaultModels.ollama]);

  // When projects arrive after init, snap the selection to the first one.
  useEffect(() => {
    if (!selectedProjectId && projects[0]) setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId]);

  // If the sidebar "+" was clicked on a different project while this pane
  // is already mounted, follow that intent.
  useEffect(() => {
    if (focusedProjectId) setSelectedProjectId(focusedProjectId);
  }, [focusedProjectId]);

  // Keep the pill on something that can actually run. Two triggers: the
  // chosen backend got switched off in settings (always re-seed — a
  // disabled backend can't be sent to), or the health probe landed after
  // mount and the seeded default turns out not to be installed. The latter
  // only applies while the user hasn't picked a backend themselves.
  useEffect(() => {
    if (!isBackendEnabled(settings, backend)) {
      setBackend(pickDefaultBackend(settings, backendHealth));
      setModel('');
      return;
    }
    if (backendPicked) return;
    const seeded = pickDefaultBackend(settings, backendHealth);
    if (seeded === backend) return;
    setBackend(seeded);
    // The model belonged to the backend we just moved off — an empty model
    // means "whatever this CLI defaults to", which is the right answer here.
    setModel('');
  }, [settings, backend, backendHealth, backendPicked]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedProjectLabel = useMemo(() => {
    if (!selectedProject) return null;
    const fromPath = pathBasename(selectedProject.path).trim();
    return fromPath || selectedProject.name;
  }, [selectedProject]);
  // `false` once probed and the folder isn't a git repo. We use this to
  // reframe the welcome screen as a "work folder" — review data, build
  // reports, investigate — rather than the build/code framing that fits a
  // git project. `true`/`undefined` keep the default coding framing.
  const projectIsGitRepo = useStore((s) => s.projectIsGitRepo);
  // "Not a git repo" was the app's only proxy for "not a code project", and
  // everyday projects invalidated it: they are git repos precisely so undo
  // works, which used to route the most non-technical folders in the app into
  // the engineer copy ("What should we build in Marketing101?"). Intent is
  // recorded on the project now, so ask that instead of asking git.
  const isEverydayFolder =
    !focusedWorkspace && !!selectedProject && isEverydayProject(selectedProject);
  const isNonGitProject =
    (!focusedWorkspace && !!selectedProject && projectIsGitRepo[selectedProject.id] === false) ||
    isEverydayFolder;
  // Agent mode mints git worktrees: one for a single git-backed project,
  // or one per member repo for a workspace (wired through a coordinator).
  // Excludes non-git folders and empty workspaces.
  const canRunAgent =
    (!!focusedWorkspace && focusedWorkspace.projectIds.length > 0) ||
    (!!selectedProject && !focusedWorkspace && projectIsGitRepo[selectedProject.id] !== false);
  // Review/docs check out one existing branch in a detached worktree, which
  // only makes sense against a single git repo — a workspace spans several.
  const canRunDetached =
    !!selectedProject && !focusedWorkspace && projectIsGitRepo[selectedProject.id] !== false;
  const detachedKind: 'review' | 'docs' | null =
    runMode === 'review' || runMode === 'docs' ? runMode : null;
  // Keep the toggle honest if the target changes out from under it.
  useEffect(() => {
    if (!canRunAgent && runMode === 'agent') setRunMode('local');
    if (!canRunDetached && (runMode === 'review' || runMode === 'docs')) setRunMode('local');
  }, [canRunAgent, canRunDetached, runMode]);

  // Branches for the review/docs target picker. Fetches origin behind the
  // cached list so a branch pushed from elsewhere (the PR you just opened)
  // is pickable without dropping to a terminal.
  const {
    branches: targetBranches,
    loading: loadingTargets,
    refreshing: refreshingTargets,
    refresh: refreshTargets,
  } = useProjectBranches(selectedProject?.path, !!detachedKind && canRunDetached);
  // The base is whatever the project is currently on — same default the
  // "+ agent" sheet lands on — so reviewing that branch against itself
  // would diff nothing.
  const targetBranchOptions = useMemo(
    () => targetBranches.filter((b) => b !== branch),
    [targetBranches, branch],
  );
  useEffect(() => {
    if (!detachedKind) return;
    if (targetBranch && targetBranchOptions.includes(targetBranch)) return;
    setTargetBranch(targetBranchOptions[0] ?? '');
  }, [detachedKind, targetBranch, targetBranchOptions]);

  // Resolve current branch for the selected project once we know which one
  // the user picked. Cheap — one git command — and updates reactively.
  useEffect(() => {
    if (!selectedProject) return;
    let cancelled = false;
    window.overcli
      .invoke('git:run', { args: ['branch', '--show-current'], cwd: selectedProject.path })
      .then((res) => {
        if (cancelled) return;
        const name = res.stdout.trim();
        setBranch(name || 'main');
      })
      .catch(() => setBranch('main'));
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  // Tell the store what a send from here would create, so typing warms a
  // backend process against the id this conversation will be born with (see
  // `setPendingNewConversation`). Registered from an effect rather than read
  // during render, so the composer's per-keystroke draft writes cost nothing
  // here. Only 'local' runs are eligible: the agent/review/docs modes chat in
  // a worktree that doesn't exist yet, so there is no cwd to warm against.
  useEffect(() => {
    if (runMode !== 'local' || (!focusedWorkspace && !selectedProject)) {
      setPendingNewConversation(null);
      return;
    }
    setPendingNewConversation({
      draftKey: WELCOME_KEY,
      projectId: focusedWorkspace ? undefined : selectedProject!.id,
      workspaceId: focusedWorkspace?.id,
      backend,
      model,
      permissionMode,
      effortLevel: effort,
    });
    // No cleanup: unregistering on every dep change would re-mint the id and
    // orphan the warm process each time a pill moves. A target left behind on
    // unmount is harmless — `newConversation` only adopts an id that was
    // actually warmed for that same container.
  }, [runMode, focusedWorkspace, selectedProject, backend, model, permissionMode, effort]);

  /// Hand a freshly-minted agent conversation the composer's pill
  /// selections + attachments, then fire the opening turn. Shared by the
  /// build-agent and review/docs paths, which differ only in what prompt
  /// they send.
  const applyPillsAndSend = async (
    convId: UUID,
    prompt: string,
    attachments: Attachment[],
  ) => {
    clearAttachments(convId);
    for (const a of attachments) addAttachment(convId, a);
    void setPrimaryBackend(convId, backend);
    void setPermissionMode(convId, permissionMode);
    if (backend === 'claude' || backend === 'codex') {
      // Empty is an intentional Auto override, not a missing selection.
      void setEffortLevel(convId, effort);
    }
    if (model) void setBackendModel(convId, backend, model);
    if (reviewPreset !== 'off') void setReviewPreset(convId, reviewPreset);
    setDraft(WELCOME_KEY, '');
    clearAttachments(WELCOME_KEY);
    // Not awaited: `coalescedSave` resolves on a 250ms timer, and nothing
    // below reads the persisted copy — see `newConversation` in the store.
    void saveProjects();
    selectConversation(convId);
    await send(convId, prompt);
  };

  // Agent mode: mint git worktree(s) on fresh branch(es), then fire the
  // prompt into the resulting agent. For a single project that's a
  // branched build agent; for a workspace it's a coordinator spanning one
  // worktree per member repo. Either way we apply the pill selections and
  // move welcome-key attachments over, exactly like handleSend.
  const handleSendAsAgent = async (prompt: string, attachments: Attachment[]) => {
    if (creatingAgent.current) return;
    creatingAgent.current = true;
    setAgentError(null);
    setAgentProgress(null);
    const applyAndSend = async (convId: UUID) => applyPillsAndSend(convId, prompt, attachments);
    try {
      if (focusedWorkspace) {
        // Resolve each member's base branch (repos may differ, e.g. one on
        // `main` and one on `master`), then let the store mint a worktree
        // per member and wire them through a coordinator.
        const members = focusedWorkspace.projectIds
          .map((pid) => projects.find((p) => p.id === pid))
          .filter((p): p is NonNullable<typeof p> => !!p);
        const baseBranches: Record<UUID, string> = {};
        await Promise.all(
          members.map(async (p) => {
            const detected = await window.overcli
              .invoke('git:detectBaseBranch', p.path)
              .catch(() => '');
            if (detected?.trim()) baseBranches[p.id] = detected.trim();
          }),
        );
        setAgentProgress(
          members.length === 1
            ? 'Creating worktree…'
            : `Creating worktrees across ${members.length} repos…`,
        );
        const conv = await newWorkspaceAgent({
          workspaceId: focusedWorkspace.id,
          name: deriveAgentName(prompt),
          baseBranches,
          onProgress: setAgentProgress,
        });
        if (!conv) {
          setAgentError(
            'All worktree creations failed. Check that each member repo has a usable branch.',
          );
          return;
        }
        await applyAndSend(conv.id);
      } else if (selectedProject) {
        setAgentProgress('Creating worktree…');
        await createBranchedAgent({
          project: selectedProject,
          projectId: selectedProject.id,
          settings,
          preferredBackend: backend,
          name: deriveAgentName(prompt),
          baseBranch: branch,
          onError: setAgentError,
          onCreated: applyAndSend,
        });
      }
    } finally {
      creatingAgent.current = false;
      setAgentProgress(null);
    }
  };

  // Review/docs mode: check the picked branch out in a detached worktree
  // and fire the same read-only opening prompt the "+ agent" sheet uses,
  // with whatever the user typed appended as extra direction.
  const handleSendAsDetachedAgent = async (
    kind: 'review' | 'docs',
    prompt: string,
    attachments: Attachment[],
  ) => {
    if (creatingAgent.current) return;
    if (!selectedProject) return;
    if (!targetBranch) {
      setAgentError(`Pick a branch to ${kind === 'docs' ? 'document' : 'review'} first.`);
      return;
    }
    creatingAgent.current = true;
    setAgentError(null);
    setAgentProgress(
      kind === 'docs' ? 'Checking out docs worktree…' : 'Checking out review worktree…',
    );
    try {
      await createDetachedAgent({
        kind,
        project: selectedProject,
        projectId: selectedProject.id,
        settings,
        preferredBackend: backend,
        targetBranch,
        baseBranch: branch,
        onError: setAgentError,
        onCreated: async (convId, initialPrompt) => {
          const extra = prompt.trim()
            ? `\n\n---\n\nAdditional direction from the user for this ${kind}:\n\n${prompt.trim()}`
            : '';
          await applyPillsAndSend(convId, `${initialPrompt}${extra}`, attachments);
        },
      });
    } finally {
      creatingAgent.current = false;
      setAgentProgress(null);
    }
  };

  const handleSend = async (prompt: string, attachments: Attachment[]) => {
    if (detachedKind && canRunDetached) {
      await handleSendAsDetachedAgent(detachedKind, prompt, attachments);
      return;
    }
    if (runMode === 'agent' && canRunAgent) {
      await handleSendAsAgent(prompt, attachments);
      return;
    }
    const conv = focusedWorkspace
      ? await newConversationInWorkspace(focusedWorkspace.id)
      : selectedProject
      ? await newConversation(selectedProject.id)
      : null;
    if (!conv) return;
    // Move any welcome-key attachments to the new conversation's key.
    clearAttachments(conv.id);
    for (const a of attachments) addAttachment(conv.id, a);
    // Apply the pill selections as the conversation's initial settings.
    // These setters update in-memory state synchronously (via
    // `mutateConversation`) and only `await` the disk persistence step —
    // awaiting them here would defer `send` by several IPC roundtrips,
    // during which the freshly-selected conversation renders `NewAgentIntro`
    // with empty events before `send`'s optimistic user bubble lands. Fire
    // them without awaiting so the state is ready for `send` this tick.
    void setPrimaryBackend(conv.id, backend);
    void setPermissionMode(conv.id, permissionMode);
    if (backend === 'claude' || backend === 'codex') {
      // Empty is an intentional Auto override, not a missing selection.
      void setEffortLevel(conv.id, effort);
    }
    if (model) void setBackendModel(conv.id, backend, model);
    // Apply rebound preset *after* setPrimaryBackend so the resolver
    // sees the right primary. Off is the harmless no-op default and
    // doesn't need to be dispatched.
    if (reviewPreset !== 'off') void setReviewPreset(conv.id, reviewPreset);
    // Fire the send. store.send reads draft+attachments from the store so
    // we explicitly cleared ours above and passed attachments through.
    setDraft(WELCOME_KEY, '');
    clearAttachments(WELCOME_KEY);
    await send(conv.id, prompt);
  };

  if (projects.length === 0) {
    return <EmptyWelcome onPick={pickProject} backendHealth={backendHealth} />;
  }

  const headline = isNonGitProject
    ? `What can we dig into in ${selectedProjectLabel ?? selectedProject?.name}?`
    : `What should we build in ${focusedWorkspace?.name ?? selectedProjectLabel ?? selectedProject?.name ?? 'overcli'}?`;
  const placeholder = isNonGitProject
    ? `Review data, draft a report, investigate — ask ${backendName(backend)} anything. @ to reference files · / for commands`
    : `Ask ${backendName(backend)} anything. @ to reference files · / for commands`;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto relative">
      {(focusedWorkspace || selectedProject) && (
        <div className="absolute top-6 right-8 z-10">
          <ProjectFilesBubble
            project={
              focusedWorkspace
                ? { ...focusedWorkspace, path: focusedWorkspace.rootPath }
                : selectedProject!
            }
            variant={!focusedWorkspace && isNonGitProject ? 'documents' : 'files'}
          />
        </div>
      )}
      <div className="w-full max-w-[680px]">
        <div className="text-center text-2xl font-semibold mb-5">{headline}</div>
        {isNonGitProject && selectedProject && (
          <StarterPrompts
            project={selectedProject}
            onPick={(text) => {
              setDraft(WELCOME_KEY, text);
              setComposerFocusNudge((n) => n + 1);
            }}
          />
        )}
        {selectedProject &&
          !focusedWorkspace &&
          !isEverydayFolder &&
          projectIsGitRepo[selectedProject.id] === false && (
            <div className="text-center text-xs text-ink-faint mb-4">
              Working with documents rather than code?{' '}
              <button
                className="text-accent hover:underline"
                onClick={() =>
                  openSheet({ type: 'everydayConversion', projectId: selectedProject.id })
                }
              >
                Make this an everyday project
              </button>{' '}
              and Overcli will show your documents, save as you type, and keep an undo history.
            </div>
          )}
        <Composer
          draftKey={WELCOME_KEY}
          autoFocus
          disabled={noBackendReady(backendHealth)}
          focusSignal={welcomeFocusToken + composerFocusNudge}
          variant="welcome"
          rootPath={selectedProject?.path}
          slashCommands={slashCommands}
          placeholder={placeholder}
          onSend={handleSend}
          footer={
            <>
              <Pill
                label={modeLabel(permissionMode)}
                color={permissionTone(permissionMode)}
                items={(['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'] as PermissionMode[])
                  .filter((m) => m !== 'auto' || backend === 'claude')
                  .map((m) => ({
                    value: m,
                    label: modeLabel(m),
                  }))}
                onPick={(v) => setLocalPermissionMode(v as PermissionMode)}
              />
              <Pill
                label={backendName(backend)}
                color={backendColor(backend)}
                items={enabledBackends(settings).map((b) => ({
                  value: b,
                  label: backendName(b),
                  // Say so before they pick it, not after the send fails.
                  note:
                    backendHealth[b]?.kind === 'unauthenticated'
                      ? 'Installed, signed out'
                      : backendHealth[b] && backendHealth[b].kind !== 'ready'
                      ? 'Not installed'
                      : undefined,
                }))}
                onPick={(v) => {
                  const next = v as Backend;
                  setBackend(next);
                  setBackendPicked(true);
                  // Backends disagree on what their default effort is, so an
                  // untouched picker re-seeds rather than carrying the old
                  // backend's default across.
                  if (!effortPicked) setEffort(effortForBackend(settings, next));
                  // `auto` is Claude-only; demote to default when leaving Claude
                  // so the picker label and the eventual mapped behaviour agree.
                  if (next !== 'claude' && permissionMode === 'auto') {
                    setLocalPermissionMode('default');
                  }
                  // Old model belonged to the previous CLI and almost
                  // certainly isn't a valid model id for the new one
                  // (e.g. `sonnet-4-6` is not a Codex model). Re-pick:
                  // if a tier-shifting preset is active, snap to that
                  // preset's primary tier on the new CLI; otherwise
                  // fall back to the first supported model for the new
                  // backend.
                  if (reviewPreset === 'cheap-paranoid') {
                    const cheap = TIERS[next]?.cheap;
                    const allowed = modelOptionsFor(next, ollamaPulledModels);
                    setModel(cheap ?? allowed[0] ?? '');
                  } else {
                    const allowed = modelOptionsFor(next, ollamaPulledModels);
                    setModel(allowed[0] ?? '');
                  }
                }}
              />
              <Pill
                label={model ? shortModel(model) : 'Model'}
                items={modelOptionsFor(
                  backend,
                  ollamaPulledModels,
                ).map((m) => ({
                  value: m,
                  label: shortModel(m),
                }))}
                onPick={(v) => setModel(v)}
              />
              {(backend === 'claude' || backend === 'codex') && (
                <Pill
                  label={effortLabel(effort)}
                  items={([
                    { value: '' as EffortLevel, label: 'Auto (model default)' },
                    { value: 'low' as EffortLevel, label: 'Low' },
                    { value: 'medium' as EffortLevel, label: 'Medium' },
                    { value: 'high' as EffortLevel, label: 'High' },
                    { value: 'max' as EffortLevel, label: 'Max' },
                  ]).map((o) => ({ value: o.value, label: o.label }))}
                  onPick={(v) => {
                    setEffort(v as EffortLevel);
                    setEffortPicked(true);
                  }}
                />
              )}
              <Pill
                label={
                  reviewPreset === 'off'
                    ? 'Rebound'
                    : PRESETS.find((p) => p.key === reviewPreset)?.label ?? 'Custom'
                }
                color={reviewPreset === 'off' ? undefined : '#c29bff'}
                items={[
                  { value: 'off', label: 'No rebound' },
                  ...PRESETS.map((p) => {
                    // Independent needs at least one non-primary CLI
                    // installed. Disable + explain if there's no other
                    // CLI available — same gating logic the rebound
                    // popover uses on the conversation header.
                    if (p.key === 'independent') {
                      const others = (['claude', 'codex', 'gemini', 'ollama'] as const).filter(
                        (b) => b !== backend && installedReviewers[b],
                      );
                      if (others.length === 0) {
                        return {
                          value: p.key,
                          label: p.label,
                          note: 'Install another CLI to enable',
                          disabled: true,
                        };
                      }
                    }
                    return { value: p.key, label: p.label };
                  }),
                ]}
                onPick={(v) => {
                  const next = v as ReviewPreset | 'off';
                  const prev = reviewPreset;
                  setLocalReviewPreset(next);
                  // Cheap-and-paranoid only delivers value when primary
                  // is on the cheap tier. Auto-flip the primary model
                  // when entering it; auto-restore to the user's
                  // configured default when leaving so we don't silently
                  // strand them on Sonnet after they switch presets.
                  if (next === 'cheap-paranoid') {
                    const cheap = TIERS[backend]?.cheap;
                    if (cheap) setModel(cheap);
                  } else if (prev === 'cheap-paranoid') {
                    setModel(settings.backendDefaultModels[backend] ?? '');
                  }
                }}
              />
            </>
          }
        />
        {(() => {
          // Mismatch warning for cheap-paranoid: the preset's value is
          // "cheap primary, smart reviewer" — leaving primary on the smart
          // tier defeats the purpose. We don't auto-fix the model so users
          // stay in control; just surface the conflict here.
          if (reviewPreset !== 'cheap-paranoid') return null;
          const effectiveModel = model || settings.backendDefaultModels[backend] || '';
          if (modelTier(backend, effectiveModel) !== 'smart') return null;
          return (
            <div className="mt-2 text-[11px] text-amber-400 text-center">
              Cheap-and-paranoid expects a cheap primary; you're on{' '}
              <span className="font-mono">{shortModel(effectiveModel)}</span>. Switch to the
              cheap tier to actually save tokens.
            </div>
          );
        })()}
        {reviewPreset !== 'off' && (() => {
          const spec = PRESETS.find((p) => p.key === reviewPreset);
          const resolved = resolvePreset(reviewPreset, backend);
          if (!spec || !resolved) return null;
          // Cost dots: 1 = low, 2 = medium, 3 = high. Lets users see at a
          // glance whether a preset is cheap or pricey before opting in.
          const costDots = spec.relativeCost === 'low' ? 1 : spec.relativeCost === 'medium' ? 2 : 3;
          const costColor =
            spec.relativeCost === 'low'
              ? 'text-emerald-400'
              : spec.relativeCost === 'medium'
              ? 'text-amber-400'
              : 'text-rose-400';
          return (
            <div className="mt-3 rounded-lg border border-card-strong bg-card/40 p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <div className="font-medium" style={{ color: '#c29bff' }}>
                  Rebound: {spec.label}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={'text-[10px] tracking-widest ' + costColor}
                    title={`Relative cost per review: ${spec.relativeCost}`}
                  >
                    {'•'.repeat(costDots)}
                    <span className="opacity-30">{'•'.repeat(3 - costDots)}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                    {spec.mode === 'collab' ? 'Collab' : 'Review'}
                  </span>
                </div>
              </div>
              <div className="text-ink-muted mb-1">{spec.description}</div>
              <div className="text-[11px] text-ink-faint mb-2">
                <span className="text-ink-muted">Best for:</span> {spec.bestFor}
              </div>
              {resolved.reviewPersona && (
                PERSONA_REQUIRES_CODE_CHANGES[resolved.reviewPersona] ? (
                  <div className="text-[11px] text-amber-400/80 mb-2">
                    Fires only on turns that change code (Edit, Write, Patch). Skipped on
                    text-only / Q&amp;A turns.
                  </div>
                ) : (
                  <div className="text-[11px] text-ink-muted mb-2">
                    Fires every turn — including text-only / Q&amp;A turns.
                  </div>
                )
              )}
              <div className="text-[11px] text-ink-faint flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  Reviewer:{' '}
                  <span className="text-ink" style={{ color: backendColor(resolved.reviewBackend) }}>
                    {backendName(resolved.reviewBackend)}
                  </span>
                </span>
                {resolved.reviewModel && (
                  <span>
                    Model: <span className="font-mono text-ink">{shortModel(resolved.reviewModel)}</span>
                  </span>
                )}
                {resolved.reviewPersona && (
                  <span>
                    Persona: <span className="text-ink">{resolved.reviewPersona}</span>
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted justify-center flex-wrap">
          <ContextPill
            label={focusedWorkspace?.name ?? selectedProject?.name ?? 'Pick project'}
            projects={projects}
            workspaces={workspaces}
            onPickProject={(id) => startNewConversation(id)}
            onPickWorkspace={(id) => startNewConversationInWorkspace(id)}
            onAdd={pickProject}
          />
          <Pill
            label={RUN_MODE_LABELS[runMode]}
            color={runMode === 'local' ? undefined : '#7dd3fc'}
            items={runModeItems(canRunAgent, canRunDetached)}
            onPick={(v) => setRunMode(v as RunMode)}
          />
          {detachedKind ? (
            <div className="inline-flex items-center gap-1.5 text-xs">
              <span className="text-ink-faint whitespace-nowrap">
                {detachedKind === 'docs' ? 'document' : 'review'}
              </span>
              <div className="min-w-[140px] max-w-[240px]">
                <BranchCombobox
                  options={targetBranchOptions}
                  value={targetBranch}
                  onChange={setTargetBranch}
                  disabled={loadingTargets}
                  className="px-2.5 py-1 rounded-full bg-card-strong border border-card text-xs"
                  placeholder={loadingTargets ? 'Loading branches…' : 'No branches available'}
                  emptyText={
                    refreshingTargets
                      ? 'Still fetching from origin…'
                      : 'No matching branches. If it was just pushed, hit ↻.'
                  }
                />
              </div>
              {branch && (
                <span className="text-ink-faint whitespace-nowrap">vs {branch}</span>
              )}
              <button
                type="button"
                onClick={refreshTargets}
                disabled={refreshingTargets}
                title="Fetch from origin and reload the branch list"
                className="text-ink-faint hover:text-ink disabled:opacity-40"
              >
                {refreshingTargets ? '…' : '↻'}
              </button>
            </div>
          ) : (
            !focusedWorkspace &&
            !isNonGitProject &&
            branch && (
              <Pill
                label={runMode === 'agent' ? `off ${branch}` : branch}
                items={[{ value: branch, label: branch }]}
                onPick={() => {}}
              />
            )
          )}
        </div>
        {agentProgress && (
          <div className="mt-2 text-[11px] text-ink-muted text-center">{agentProgress}</div>
        )}
        {agentError && (
          <div className="mt-2 text-[11px] text-red-400 text-center">{agentError}</div>
        )}
        <ResumeRow
          conversations={
            focusedWorkspace
              ? focusedWorkspace.conversations ?? []
              : selectedProject?.conversations ?? []
          }
        />
        <WelcomeFlowsRow
          projectPath={selectedProject?.path}
          workspaceRootPath={focusedWorkspace?.rootPath}
          targetLabel={focusedWorkspace?.name ?? selectedProject?.name ?? 'this context'}
        />
      </div>
    </div>
  );
}

/// Turn the first words of the prompt into a readable agent/branch name
/// (createBranchedAgent slugifies it for the actual git branch). Falls
/// back to a generic label when the prompt has no word characters.
function deriveAgentName(prompt: string): string {
  const words = prompt
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 6)
    .join(' ');
  return words || 'agent';
}

/// "Or run a flow" section beneath the welcome composer. Surfaces saved
/// flows as proper cards (monogram + name + step preview) — clicking a
/// card slides a run panel into the same slot so the user stays in
/// context. Collapsed it shows the first MAX_VISIBLE entries; expanded it
/// groups by provenance (starred / yours / this project / installed) so a
/// pile of registry installs doesn't bury the two flows you wrote.
const MAX_VISIBLE_FLOWS = 4;

function WelcomeFlowsRow({
  projectPath,
  workspaceRootPath,
  targetLabel,
}: {
  projectPath: string | undefined;
  workspaceRootPath: string | undefined;
  targetLabel: string;
}) {
  const setDetailMode = useStore((s) => s.setDetailMode);
  const flows = useFlowsStore((s) => s.flows);
  const loaded = useFlowsStore((s) => s.loaded);
  const reload = useFlowsStore((s) => s.reload);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const closeFlowEditor = useFlowsStore((s) => s.closeEditor);
  const applyRunUpdate = useFlowsStore((s) => s.applyRunUpdate);
  const setLaunchProgress = useFlowsStore((s) => s.setLaunchProgress);
  const launchProgressMap = useFlowsStore((s) => s.launchProgress);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const starredFlows = useStore((s) => s.settings.starredFlows ?? []);
  const installedFlows = useStore((s) => s.settings.installedRegistryFlows);
  const registryEntries = useFlowsStore((s) => s.registryEntries);
  const registryLoaded = useFlowsStore((s) => s.registryLoaded);
  const browseRegistries = useFlowsStore((s) => s.browseRegistries);
  const installFromRegistry = useFlowsStore((s) => s.installFromRegistry);
  const [pickedFlowId, setPickedFlowId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // The full modal is still there for browsing by tag axis; the inline
  // results below cover the common case of "I know what I want, is it
  // published?" without leaving the screen.
  const [browseQuery, setBrowseQuery] = useState<string | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  // An AI-drafted flow that exists only in memory until the user launches
  // it. Occupies the same slot a picked flow would.
  const [draftedFlow, setDraftedFlow] = useState<Flow | null>(null);
  const saveDraftedFlow = useFlowsStore((s) => s.saveDraftedFlow);
  // The launch prompt lives in the shared draft/attachment store (keyed per
  // flow) so the Composer can drive multi-line text + image attachments,
  // exactly like the chat composer above.
  // `__`-prefixed: a sentinel draft key (not a real conversation), matching
  // the start page's `__welcome__`. Per-flow so each keeps its own draft.
  const draftKey = pickedFlowId ? `__flow-launch:${pickedFlowId}__` : '__flow-launch__';
  const setDraft = useStore((s) => s.setDraft);
  const clearAttachments = useStore((s) => s.clearAttachments);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Which side the run-in toggle starts on comes from Settings → Flows, so
  // a worktree-first user doesn't re-flip it on every launch. The toggle
  // still wins for this run; flipping the setting re-seeds the launcher.
  const defaultRunIn = useStore((s) => s.settings.defaultFlowRunIn ?? 'cwd');
  const [runIn, setRunIn] = useState<'cwd' | 'worktree'>(defaultRunIn);
  useEffect(() => setRunIn(defaultRunIn), [defaultRunIn]);
  // baseBranch starts empty — the BaseBranchSelect below populates it
  // from the repo's actual branches (and `detectBaseBranch` picks a
  // sensible default like the repo's `origin/HEAD` or whichever of
  // main/master exists). Hardcoding "main" was lying to users whose
  // repos use `master`.
  const [baseBranch, setBaseBranch] = useState('');

  // Repos the worktree(s) are minted from. For a workspace we hand the
  // selector each member's path so the branch list it shows is the
  // INTERSECTION (only branches that exist in every repo are eligible).
  const baseBranchRepoPaths = useMemo(() => {
    if (workspaceRootPath) {
      const ws = workspaces.find((w) => w.rootPath === workspaceRootPath);
      if (ws) {
        return ws.projectIds
          .map((pid) => projects.find((p) => p.id === pid))
          .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
          .map((p) => p.path);
      }
    }
    return projectPath ? [projectPath] : [];
  }, [workspaceRootPath, projectPath, workspaces, projects]);
  // Worktrees are eligible whenever we have ANY git-backed target:
  //   - Single project: mint one worktree off baseBranch.
  //   - Workspace: mint one worktree per member project and wire them
  //     through a coordinator symlink root (handled by the flow
  //     runtime). The workspace root itself isn't a git repo, but the
  //     members are — that's what matters.
  const canUseWorktree = !!workspaceRootPath || !!projectPath;

  useEffect(() => {
    if (!loaded) void reload(projects.map((p) => p.path));
  }, [loaded, projects.length]);

  const target = workspaceRootPath ?? projectPath ?? '';
  // A draft takes the same slot as a picked flow, so the launch panel,
  // worktree toggle and Composer are all shared rather than duplicated.
  const pickedFlow = draftedFlow ?? (pickedFlowId ? flows.find((f) => f.id === pickedFlowId) : null);

  const orderedFlows = useMemo(() => {
    const isStarred = (f: typeof flows[number]) =>
      starredFlows.includes(flowStarKey(f));
    return flows.slice().sort((a, b) => {
      const sa = isStarred(a) ? 0 : 1;
      const sb = isStarred(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
  }, [flows, starredFlows]);

  // Grouped view backs both the expanded list and the search results. The
  // collapsed 4-card teaser stays flat — four cards don't need headings.
  const groups = useMemo(
    () => groupFlows(flows, { starred: starredFlows, installed: installedFlows, query, tags: activeTags }),
    [flows, starredFlows, installedFlows, query, activeTags],
  );
  const tagCounts = useMemo(() => flowTagCounts(flows), [flows]);
  const topTags = useMemo(
    () => [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
    [tagCounts],
  );
  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }
  const matchCount = groups.reduce((n, g) => n + g.flows.length, 0);
  // Two different questions: `hasQuery` gates the registry lookup (a tag
  // filter alone is "narrow what I have", not "go find me something new" —
  // matching an empty query against the registry would dump six arbitrary
  // published flows on screen), while `searching` gates the expanded
  // layout, which either one should trigger.
  const hasQuery = query.trim().length > 0;
  const searching = hasQuery || activeTags.size > 0;
  // Searching or expanding both mean "show me everything that matches" —
  // the 4-card cap only applies to the resting state. Focus counts too:
  // opening the panel the moment the user clicks into the box means the
  // one unavoidable size change happens on a deliberate action, instead
  // of firing under their hands on the first keystroke.
  const grouped = searching || showAll || searchFocused;

  // Registry index is fetched (and cached in the store) the first time the
  // user searches, not on mount — a network round-trip on every welcome
  // screen to populate results nobody asked for isn't worth it.
  useEffect(() => {
    if (query.trim().length >= 2 && !registryLoaded) void browseRegistries(false);
  }, [query, registryLoaded]);

  // Published flows matching the same query, minus the ones already
  // installed (those surface in the local groups above — showing both
  // would read as a duplicate).
  const registryMatches = useMemo(() => {
    if (!hasQuery) return [];
    const have = installedRegistryKeys(flows, installedFlows);
    return registryEntries
      .filter((e) => !have.has(`${e.registryId}:${e.id}`))
      .filter((e) => registryEntryMatchesQuery(e, query))
      .slice(0, 6);
  }, [hasQuery, registryEntries, flows, installedFlows, query]);

  /// Hand the unmatched search to the flow drafter and show the result
  /// RIGHT HERE. The search text IS the description — someone typing
  /// "postmortem from an incident channel" into a flow search has already
  /// written the brief, so re-asking for it in a modal is a tax.
  ///
  /// Deliberately does not navigate to the editor: the user asked to run
  /// something, not to author a flow. They see the steps, then launch; the
  /// flow is saved on the way out (`handleRun`), so it's in the library
  /// next time without anyone having visited a builder.
  async function handleDraft() {
    const description = query.trim();
    if (!description || drafting) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await window.overcli.invoke('flows:draftFromPrompt', { description });
      if (!result.ok) {
        setDraftError(result.error);
        return;
      }
      setDraftedFlow(result.flow);
    } finally {
      setDrafting(false);
    }
  }

  async function handleInstall(entry: { registryId: string; id: string; version: string }) {
    const key = `${entry.registryId}:${entry.id}`;
    setInstallingKey(key);
    setInstallError(null);
    try {
      const res = await installFromRegistry(entry);
      if (!res.ok) {
        setInstallError(res.error || 'Install failed.');
        return;
      }
      // The new YAML is on disk but the in-memory library predates it.
      await reload(projects.map((p) => p.path));
    } finally {
      setInstallingKey(null);
    }
  }

  if (!loaded) return null;
  if (flows.length === 0) return null;

  const visibleFlows = orderedFlows.slice(0, MAX_VISIBLE_FLOWS);
  const hiddenCount = orderedFlows.length - visibleFlows.length;

  async function handleRun(prompt: string, attachments: Attachment[]) {
    const text = prompt.trim();
    if (!pickedFlow || !target || !text) {
      setError('Tell the flow what to work on, and pick a project or workspace.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // A drafted flow has never touched disk, and the runtime resolves
      // runs by flow id — so it has to be saved before it can run. Doing
      // it here (rather than at draft time) means abandoning a draft
      // leaves no junk in the library.
      let flowId = pickedFlow.id;
      if (draftedFlow) {
        const saved = await saveDraftedFlow(draftedFlow, projects.map((p) => p.path));
        if (!saved.ok) {
          setError(saved.error);
          return;
        }
        flowId = saved.flow.id;
        setDraftedFlow(null);
      }
      const result = await window.overcli.invoke('flows:startRun', {
        flowId,
        projectPath: target,
        userPrompt: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        runIn: canUseWorktree ? runIn : 'cwd',
        baseBranch: canUseWorktree && runIn === 'worktree' ? baseBranch : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const run = await window.overcli.invoke('flows:getRun', { runId: result.runId });
      if (run) applyRunUpdate(run);
      // The launch prompt has been consumed — clear it so returning to the
      // welcome screen starts fresh.
      setDraft(draftKey, '');
      clearAttachments(draftKey);
      setActiveRun(result.runId);
      setDetailMode('flows');
    } finally {
      setSubmitting(false);
      setLaunchProgress(target, null);
    }
  }

  return (
    <div className="mt-8">
      <div className="text-center text-[10px] uppercase tracking-[0.22em] text-ink-faint mb-3">
        Or run a flow
      </div>

      {/* Card grid. Clicking a card toggles its expanded run panel
          INSIDE the grid (replacing the cards) so there's no vertical
          jump and the picked card's identity is preserved. */}
      {!pickedFlow ? (
        <>
          {/* Open, the panel breaks out of the 680px composer column to
              ~960px so cards go three-across at the SAME card width rather
              than three cramped ones — 680/3 leaves ~150px for text, which
              truncates most flow names to uselessness. Centred on the
              parent via the left-1/2 trick so the composer above keeps its
              own width. At rest it stays in the column at two-across. */}
          <div
            className={
              grouped ? 'relative left-1/2 -translate-x-1/2 w-[min(60rem,92vw)]' : ''
            }
          >
          {/* The filter box only earns its space once there are enough
              flows to lose one in. Below that the grid IS the index. */}
          {flows.length > MAX_VISIBLE_FLOWS && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search your flows and the registry…"
              className="field w-full mb-2 px-3 py-1.5 text-[12px]"
            />
          )}

          {/* Tag chips, only once the panel is open — at rest they'd be a
              row of filters for a list short enough not to need them. */}
          {grouped && topTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {topTags.map(([tag, count]) => (
                <button
                  key={tag}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleTag(tag)}
                  className={
                    'text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ' +
                    (activeTags.has(tag)
                      ? 'border-accent/60 bg-accent/20 text-accent'
                      : 'border-card text-ink-faint hover:text-ink hover:border-card-strong')
                  }
                >
                  {tag} <span className="opacity-60">{count}</span>
                </button>
              ))}
              {activeTags.size > 0 && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setActiveTags(new Set())}
                  className="text-[10px] px-1.5 py-0.5 text-ink-faint hover:text-ink"
                >
                  clear
                </button>
              )}
            </div>
          )}

          {/* Results scroll INSIDE a fixed viewport rather than growing the
              page. Unbounded growth pushed the composer off the top and
              made every keystroke re-lay-out the whole welcome screen —
              and because narrowing a search shrinks the list, the page
              jittered in both directions as you typed. A constant height
              (not just a max) holds everything above it still; the cost is
              some empty space on a one-result search, which is cheaper
              than a moving target. */}
          <div
            className={
              grouped
                ? 'h-[min(46vh,30rem)] overflow-y-auto pr-1 -mr-1 overscroll-contain'
                : ''
            }
          >
          {grouped ? (
            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.key}>
                  {/* Sticky so the heading survives its own group scrolling
                      past — otherwise a long "Yours" list leaves you with
                      a wall of cards and no idea which bucket you're in. */}
                  <div className="sticky top-0 z-10 flex items-baseline gap-2 mb-1.5 px-0.5 py-1 -mx-0.5 bg-surface/90 backdrop-blur-sm">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      {group.title}
                    </span>
                    <span className="text-[10px] text-ink-faint/70">{group.flows.length}</span>
                    {group.hint && (
                      <span className="text-[10px] text-ink-faint/60 truncate">{group.hint}</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {group.flows.map((flow) => (
                      <FlowCard
                        key={`${flow.source}:${flow.id}`}
                        flow={flow}
                        picked={false}
                        onClick={() => {
                          setPickedFlowId(flow.id);
                          setError(null);
                        }}
                        onTagClick={toggleTag}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {visibleFlows.map((flow) => (
                <FlowCard
                  key={`${flow.source}:${flow.id}`}
                  flow={flow}
                  picked={false}
                  onClick={() => {
                    setPickedFlowId(flow.id);
                    setError(null);
                  }}
                />
              ))}
            </div>
          )}

          {/* The same query, against published flows. Shown inline rather
              than behind the browse modal: "nothing I have does this" and
              "here's one you can install" are the same moment. */}
          {hasQuery && (
            <div className="mt-4">
              <div className="sticky top-0 z-10 flex items-baseline gap-2 mb-1.5 px-0.5 py-1 -mx-0.5 bg-surface/90 backdrop-blur-sm">
                <span className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                  From the registry
                </span>
                {registryMatches.length > 0 && (
                  <span className="text-[10px] text-ink-faint/70">{registryMatches.length}</span>
                )}
                <span className="text-[10px] text-ink-faint/60">not installed yet</span>
              </div>
              {!registryLoaded ? (
                <div className="text-[11px] text-ink-faint px-0.5 py-2">Searching the registry…</div>
              ) : registryMatches.length === 0 ? (
                <div className="text-[11px] text-ink-faint px-0.5 py-2">
                  {matchCount === 0
                    ? 'Nothing here or in the registry matches that.'
                    : 'Nothing new in the registry for that.'}{' '}
                  <button
                    onClick={() => setBrowseQuery('')}
                    className="text-ink hover:underline underline-offset-2"
                  >
                    Browse everything →
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {registryMatches.map((entry) => (
                    <RegistryFlowCard
                      key={`${entry.registryId}:${entry.id}`}
                      entry={entry}
                      installing={installingKey === `${entry.registryId}:${entry.id}`}
                      onInstall={() => void handleInstall(entry)}
                      onPreview={() => setBrowseQuery(query)}
                    />
                  ))}
                </div>
              )}
              {installError && (
                <div className="mt-1.5 text-[11px] text-red-400 px-0.5">{installError}</div>
              )}

              {/* Third rail, and only once the first two are exhausted:
                  nothing you own does this and nothing published does
                  either, so the remaining option is to make one. Lands in
                  the editor with the drafted steps rendered — NOT straight
                  into a run. A drafted pipeline picks its own models,
                  permission modes, and may well include a step that
                  writes to the repo; that deserves a look before it goes. */}
              {registryLoaded && matchCount === 0 && registryMatches.length === 0 && (
                <button
                  onClick={() => void handleDraft()}
                  disabled={drafting}
                  className="w-full mt-2 rounded-lg border border-dashed border-accent/40 bg-accent/5 px-3 py-2.5 text-left hover:bg-accent/10 transition-colors disabled:opacity-60"
                >
                  <div className="text-[12px] text-ink">
                    {drafting
                      ? 'Drafting a flow…'
                      : `Build a flow for “${query.trim()}” with AI →`}
                  </div>
                  <div className="text-[10.5px] text-ink-faint mt-0.5">
                    {drafting
                      ? 'Asking your CLI to design the steps.'
                      : 'Writes the steps from your search. You see them before anything runs.'}
                  </div>
                </button>
              )}
              {draftError && (
                <div className="mt-1.5 text-[11px] text-red-400 px-0.5">{draftError}</div>
              )}
            </div>
          )}
          </div>
          </div>

          <div className="flex items-center justify-center gap-3 mt-2 text-[11px] text-ink-faint">
            {!searching && !showAll && hiddenCount > 0 && (
              <button
                onClick={() => setShowAll(true)}
                className="hover:text-ink underline-offset-2 hover:underline"
              >
                Show {hiddenCount} more
              </button>
            )}
            {!searching && showAll && flows.length > MAX_VISIBLE_FLOWS && (
              <button
                onClick={() => setShowAll(false)}
                className="hover:text-ink underline-offset-2 hover:underline"
              >
                Show fewer
              </button>
            )}
            <button
              onClick={() => setBrowseQuery(query)}
              className="hover:text-ink underline-offset-2 hover:underline"
            >
              Browse library
            </button>
            <button
              onClick={() => {
                // Always land on the flows library — never a leftover
                // active run or half-edited draft from a prior session.
                setActiveRun(null);
                closeFlowEditor();
                setDetailMode('flows');
              }}
              className="hover:text-ink underline-offset-2 hover:underline"
            >
              Manage flows →
            </button>
          </div>
        </>
      ) : (
        <RunPanel
            isDraft={!!draftedFlow}
            flow={pickedFlow}
            targetLabel={targetLabel}
            draftKey={draftKey}
            rootPath={target}
            error={error}
            submitting={submitting}
            onCancel={() => {
              setPickedFlowId(null);
              setDraftedFlow(null);
              setError(null);
            }}
            onRun={handleRun}
            canUseWorktree={canUseWorktree}
            isWorkspace={!!workspaceRootPath}
            runIn={runIn}
            onRunIn={setRunIn}
            baseBranch={baseBranch}
            onBaseBranch={setBaseBranch}
            baseBranchRepoPaths={baseBranchRepoPaths}
            launchProgress={launchProgressMap[target]}
          />
      )}

      {browseQuery !== null && (
        <BrowseLibraryModal
          initialQuery={browseQuery}
          onClose={() => {
            setBrowseQuery(null);
            // An install lands a new YAML in the user flows dir; without
            // this the gallery keeps showing the pre-install list.
            void reload(projects.map((p) => p.path));
          }}
        />
      )}
    </div>
  );
}

/// A published flow the user doesn't have yet, sized to sit in the same
/// grid as the local FlowCards. Deliberately NOT clickable-to-run: you
/// can't run what isn't installed, so the primary action is Install, and
/// the card body opens the full browser for the step-by-step preview.
function RegistryFlowCard({
  entry,
  installing,
  onInstall,
  onPreview,
}: {
  entry: FlowRegistryEntry;
  installing: boolean;
  onInstall: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="group relative text-left rounded-xl border border-dashed border-card-strong bg-card/10 px-3.5 py-3 transition-colors hover:bg-card/30">
      <button onClick={onPreview} className="block w-full text-left">
        <div className="text-[13px] font-semibold truncate text-ink leading-tight">
          {entry.name}
        </div>
        {entry.description && (
          <div className="text-[11px] text-ink-muted line-clamp-2 mt-1 leading-snug">
            {entry.description}
          </div>
        )}
      </button>
      {entry.tags && entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[9.5px] leading-none px-1.5 py-0.5 rounded-full border border-card text-ink-faint"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-ink-faint truncate flex-1">
          {entry.registryId} · {entry.version}
        </span>
        <button
          onClick={onInstall}
          disabled={installing}
          className="text-[10.5px] px-2 py-0.5 rounded-md border border-card-strong text-ink hover:bg-white/10 disabled:opacity-50"
        >
          {installing ? 'Installing…' : 'Install'}
        </button>
      </div>
    </div>
  );
}

/// Quick-start chips shown above the composer for non-git "work folder"
/// projects. They prefill the draft so the user can edit before sending,
/// and frame the project as a place to investigate / report rather than
/// a codebase to build in.
function StarterPrompts({
  project,
  onPick,
}: {
  project: Project;
  onPick: (text: string) => void;
}) {
  const prompts: { label: string; text: string }[] = [
    {
      label: 'Review what’s here',
      text: `Take a look around ${project.path} and give me a quick tour: what files are here, how they’re organized, and what looks worth digging into.`,
    },
    {
      label: 'Summarize the data',
      text: `Read the data files in ${project.path} and write a short summary of what they contain — columns, sizes, any obvious patterns or anomalies.`,
    },
    {
      label: 'Build a report',
      text: `Help me build a report from the contents of ${project.path}. Start by asking what the report should cover.`,
    },
    {
      label: 'Investigate something',
      text: `I want to investigate something in ${project.path}. Ask me what I’m looking for, then dig in.`,
    },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
      {prompts.map((p) => (
        <button
          key={p.label}
          onClick={() => onPick(p.text)}
          className="px-2.5 py-1 rounded-full bg-card-strong border border-card hover:border-card-strong text-xs text-ink-muted hover:text-ink"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function EmptyWelcome({
  onPick,
  backendHealth,
}: {
  onPick: () => void;
  backendHealth: Record<string, BackendHealth>;
}) {
  // Three states, not two. Until the first probe lands we know *nothing*,
  // and rendering the happy path in the meantime meant a fresh install
  // painted an enabled "Add your first project" button and then yanked it
  // away a moment later when the setup card shoved everything down the
  // page. "Checking" is its own state so the first frame is never a lie.
  const probed = backendHealthLoaded(backendHealth);
  const blocked = noBackendReady(backendHealth);
  const readyNames = ALL_SETUP_BACKENDS.filter(
    (b) => backendHealth[b]?.kind === 'ready',
  ).map((b) => backendName(b));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="min-h-full flex items-center justify-center px-8 py-10">
        <div className="w-full max-w-[760px] text-center">
        <div className="flex items-center justify-center gap-2.5">
          <HeroArt />
          <span className="text-xl font-semibold tracking-tight">
            <span className="text-ink-muted">over</span>
            <span className="text-accent">cli</span>
          </span>
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-ink-muted max-w-[460px] mx-auto">
          A desktop home for the Claude, Codex, Gemini, Copilot, and Ollama
          CLIs — chat with any model, run background agents on isolated git
          worktrees, and coordinate across repos. No API keys; just the CLIs
          you've signed into.
        </div>

        {!probed ? (
          <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-ink-faint">
            <Spinner />
            Looking for installed CLIs…
          </div>
        ) : blocked ? (
          <CliSetupGuide backendHealth={backendHealth} />
        ) : (
          <div className="mt-6 text-[11px] text-emerald-500 dark:text-emerald-400">
            {joinNames(readyNames)} ready to go.
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
          <FeatureCard
            accent="var(--c-backend-claude)"
            title="Projects"
            body="A project is a git repository on your machine. Chat with it, run tools, and keep one thread per task."
            icon={<ProjectGlyph />}
          />
          <FeatureCard
            accent="var(--c-backend-codex)"
            title="Agents"
            body="Build, review, or doc agents run in their own git worktrees so your main checkout stays clean."
            icon={<BranchGlyph />}
          />
          <FeatureCard
            accent="var(--c-accent)"
            title="Flows"
            body="Chain steps into a pipeline — each its own model, role, and tools — handing artifacts (plan → diff → review) step to step."
            icon={<FlowGlyph />}
          />
          <FeatureCard
            accent="var(--c-backend-gemini)"
            title="Workspaces"
            body="Group several projects into one workspace and fire agents that span every repo at once."
            icon={<WorkspaceGlyph />}
          />
        </div>

        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            onClick={onPick}
            disabled={blocked || !probed}
            title={blocked ? 'Set up a CLI first to add a project' : undefined}
            className="px-5 py-2.5 rounded-md bg-accent/30 text-accent hover:bg-accent/40 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent/30"
          >
            Add your first project
          </button>
          <div className="text-[11px] text-ink-faint">
            {!probed
              ? 'One moment — checking what you already have installed.'
              : blocked
              ? 'Set up a CLI above first — this unlocks as soon as one is ready.'
              : 'Pick a folder on disk. Git repos unlock agents; any folder works for chat.'}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

interface CliSetupEntry {
  backend: Backend;
  name: string;
  /// One line on what you get, so the choice isn't five identical npm
  /// commands with different package names.
  blurb: string;
  install: string;
  auth: string | null;
  docs: string;
  /// Shown above the fold as a suggested starting point. The rest sit
  /// under "Also supported" — every CLI works, but a first-run screen
  /// that refuses to have an opinion is a worse first run.
  featured?: boolean;
}

const CLI_SETUP: CliSetupEntry[] = [
  {
    backend: 'claude',
    name: 'Claude',
    blurb: 'Anthropic’s Claude Code. Broadest tool + agent support in overcli.',
    install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'claude auth login',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup',
    featured: true,
  },
  {
    backend: 'codex',
    name: 'Codex',
    blurb: 'OpenAI’s Codex CLI. Signs in with your ChatGPT account.',
    install: 'npm install -g @openai/codex',
    auth: 'codex login',
    docs: 'https://github.com/openai/codex',
    featured: true,
  },
  {
    backend: 'gemini',
    name: 'Gemini',
    blurb: 'Google’s Gemini CLI.',
    install: 'npm install -g @google/gemini-cli',
    auth: 'gemini auth login',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    backend: 'copilot',
    name: 'Copilot',
    blurb: 'GitHub Copilot CLI, on your GitHub account.',
    install: 'npm install -g @github/copilot',
    auth: 'copilot login',
    docs: 'https://www.npmjs.com/package/@github/copilot',
  },
  {
    backend: 'ollama',
    name: 'Ollama',
    blurb: 'Open models running locally. No account, no network.',
    install: 'Download from ollama.com',
    auth: null,
    docs: 'https://ollama.com/download',
  },
];

const ALL_SETUP_BACKENDS = CLI_SETUP.map((c) => c.backend);

/// "Claude", "Claude and Codex", "Claude, Codex and Ollama".
function joinNames(names: string[]): string {
  if (names.length === 0) return 'No CLI';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function CliSetupGuide({ backendHealth }: { backendHealth: Record<string, BackendHealth> }) {
  const refreshBackendHealth = useStore((s) => s.refreshBackendHealth);
  const openSheet = useStore((s) => s.openSheet);
  const [recheckedAt, setRecheckedAt] = useState(0);

  // Someone staring at this screen is, right now, in a terminal running one
  // of the commands below. Poll while we're blocked so the app notices on
  // its own — the alternative is a user who installs a CLI, comes back to a
  // screen that still says "install a CLI", and concludes the app is broken.
  // `force` drops main's 15s probe cache; only when the window has focus, so
  // a backgrounded app isn't respawning CLIs forever.
  useEffect(() => {
    const tick = () => {
      if (!document.hasFocus()) return;
      void refreshBackendHealth(true);
    };
    const id = setInterval(tick, 4000);
    // Coming back from the terminal is the exact moment the answer changes.
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [refreshBackendHealth]);

  const rows = CLI_SETUP.map((cli) => ({
    ...cli,
    health: backendHealth[cli.backend],
    // Absent means we haven't heard about it; treat as missing rather than
    // rendering an empty row.
    kind: backendHealth[cli.backend]?.kind ?? 'missing',
  }))
    // `unknown` is only ever produced by the store for a backend the user
    // turned off in Settings. Telling someone to npm-install something they
    // deliberately disabled is noise.
    .filter((r) => r.kind !== 'ready' && r.kind !== 'unknown');

  if (rows.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-amber-500/40 bg-surface-elevated p-5 text-left">
        <div className="text-sm font-medium text-ink">Every CLI is switched off</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          All five backends are disabled in settings, so there's nothing for overcli to
          drive. Re-enable one to get started.
        </div>
        <button
          onClick={() => openSheet({ type: 'settings' })}
          className="mt-3 px-3 py-1.5 rounded-md bg-accent/25 text-accent hover:bg-accent/35 text-xs font-medium"
        >
          Open settings
        </button>
      </div>
    );
  }

  // An installed-but-signed-out CLI is one click from done, so it leads —
  // it's a far shorter path than any install below it.
  const signIn = rows.filter((r) => r.kind === 'unauthenticated');
  const rest = rows.filter((r) => r.kind !== 'unauthenticated');
  const featured = rest.filter((r) => r.featured);
  const others = rest.filter((r) => !r.featured);

  const headline =
    signIn.length > 0
      ? `Sign in to ${joinNames(signIn.map((r) => r.name))} to get started`
      : 'Install a coding CLI to get started';
  const subline =
    signIn.length > 0
      ? `${signIn.length === 1 ? 'It’s' : 'They’re'} already installed — one sign-in and you're in. overcli picks it up automatically.`
      : 'overcli drives the coding CLIs you sign into — there are no API keys to paste here. Set up any one of these and this screen unlocks on its own.';

  return (
    <div className="mt-6 rounded-lg border border-amber-500/40 bg-surface-elevated p-5 text-left">
      <div className="text-sm font-medium text-ink">{headline}</div>
      <div className="mt-1 mb-4 text-[12px] leading-relaxed text-ink-muted">{subline}</div>

      <div className="flex flex-col gap-1.5">
        {signIn.map((row) => (
          <CliSetupRow key={row.backend} row={row} />
        ))}
        {featured.map((row) => (
          <CliSetupRow key={row.backend} row={row} />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <div className="mt-4 mb-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            Also supported
          </div>
          <div className="flex flex-col gap-1.5">
            {others.map((row) => (
              <CliSetupRow key={row.backend} row={row} compact />
            ))}
          </div>
        </>
      )}

      <div className="mt-4 pt-3 border-t border-card flex items-center gap-2 text-[10.5px] text-ink-faint">
        <Spinner />
        <span className="flex-1">Watching for a CLI — no need to restart overcli.</span>
        <button
          onClick={() => {
            setRecheckedAt(Date.now());
            void refreshBackendHealth(true);
          }}
          className="rounded px-1.5 py-0.5 font-medium text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          {recheckedAt ? 'Check again' : 'Check now'}
        </button>
      </div>
    </div>
  );
}

type CliSetupRowData = CliSetupEntry & { health?: BackendHealth; kind: BackendHealth['kind'] };

function CliSetupRow({ row, compact }: { row: CliSetupRowData; compact?: boolean }) {
  const { backend, name, blurb, install, auth, docs, kind, health } = row;
  const isAuth = kind === 'unauthenticated';
  const command = isAuth && auth ? auth : install;
  // "Download from ollama.com" is prose, not something to paste in a shell.
  const canCopy = command.startsWith('npm') || isAuth;
  return (
    <div className="rounded-md px-3 py-2 bg-card/60">
      <div className="flex items-center gap-2.5">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            backgroundColor: isAuth ? '#f59e0b' : backendColor(backend),
            opacity: isAuth ? 1 : 0.45,
          }}
        />
        <span className="text-xs font-semibold shrink-0" style={{ color: backendColor(backend) }}>
          {name}
        </span>
        {isAuth ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300 shrink-0">
            installed · signed out
          </span>
        ) : (
          <code className="flex-1 min-w-0 text-[11px] font-mono text-ink truncate">{command}</code>
        )}
        {isAuth && <span className="flex-1" />}
        {isAuth && <SignInButton backend={backend} name={name} />}
        {canCopy && <CopyButton value={command} />}
        <a
          href={docs}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:text-accent hover:bg-card-strong"
          title={`${name} install & sign-in docs`}
        >
          Docs ↗
        </a>
      </div>
      {isAuth && (
        <code className="mt-1 block text-[11px] font-mono text-ink-muted truncate">{command}</code>
      )}
      {!compact && !isAuth && (
        <div className="mt-0.5 text-[10.5px] text-ink-faint">{blurb}</div>
      )}
      {/* An `error` kind means the binary is there but wouldn't run — a
          version mismatch, a broken shim, a quarantined binary. The install
          command won't fix that, so show what actually went wrong. */}
      {kind === 'error' && health?.message && (
        <div className="mt-1 text-[10.5px] text-red-500 dark:text-red-400 break-words">
          Found it, but it wouldn't run: {health.message}
        </div>
      )}
    </div>
  );
}

/// Opens Terminal on the backend's login command (same path the in-chat
/// auth banner uses). Beats "copy this, find a terminal, paste it".
function SignInButton({ backend, name }: { backend: Backend; name: string }) {
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<{ text: string; command?: string } | null>(null);
  return (
    <>
      {error && <span className="text-[10px] text-red-400 shrink-0">{error.text}</span>}
      {error?.command && <CopyButton value={error.command} />}
      <button
        onClick={async () => {
          setLaunching(true);
          setError(null);
          try {
            const res = await window.overcli.invoke('auth:openCliLogin', backend);
            if (res.ok) setLaunched(true);
            else setError({ text: res.error, command: res.command });
          } finally {
            setLaunching(false);
          }
        }}
        disabled={launching}
        title={`Open Terminal and sign into ${name}`}
        className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
      >
        {launching ? 'Opening…' : launched ? 'Reopen Terminal' : 'Sign in'}
      </button>
    </>
  );
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function FeatureCard({
  accent,
  title,
  body,
  icon,
}: {
  accent: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-card bg-surface-elevated p-4 flex flex-col gap-2"
      style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
    >
      <div
        className="w-9 h-9 rounded-md flex items-center justify-center"
        style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
      >
        {icon}
      </div>
      <div className="text-sm font-medium text-ink">{title}</div>
      <div className="text-xs text-ink-muted leading-relaxed">{body}</div>
    </div>
  );
}

/// Decorative hero. Matches the app icon: a shell-prompt mark — a bar
/// above a right-pointing chevron — sized up and rendered in the
/// current-ink color so it inherits the light/dark theme.
/// The actual app icon (mirrors build/icon.svg) so onboarding matches the
/// dock/installer brand. Inlined rather than imported as an asset so it's
/// pixel-exact at any size and renders identically in light and dark.
function HeroArt() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 1024 1024"
      className="shadow-sm rounded-[22%]"
      aria-label="overcli"
    >
      <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#ffffff" />
      <g fill="none" stroke="#000000" strokeWidth="45" strokeLinecap="round" strokeLinejoin="round">
        <line x1="395" y1="372" x2="630" y2="372" />
        <polyline points="395,475 612,575 395,675" />
      </g>
    </svg>
  );
}

function ProjectGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlowGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="5.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10.5" y="5.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7.5h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.8 6.2L9.2 7.5L7.8 8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="6" r="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 9c0-2 2-3 4-3h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function WorkspaceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5H5.7L6.7 3.6H12.5V5.5H3.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 5.5H4L5 6.5H14.5V13.3A1 1 0 0113.5 14.3H2.5A1 1 0 011.5 13.3V5.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ContextPill({
  label,
  projects,
  workspaces,
  onPickProject,
  onPickWorkspace,
  onAdd,
}: {
  label: string;
  projects: Project[];
  workspaces: Workspace[];
  onPickProject: (id: UUID) => void;
  onPickWorkspace: (id: UUID) => void;
  onAdd: () => void;
}) {
  const items: PillItem[] = [];
  if (workspaces.length > 0) {
    items.push({ value: '__h_workspaces__', label: 'Workspaces', kind: 'header' });
    for (const w of workspaces) {
      items.push({ value: `w:${w.id}`, label: w.name, note: `${w.projectIds.length} project${w.projectIds.length === 1 ? '' : 's'}` });
    }
  }
  if (projects.length > 0) {
    items.push({ value: '__h_projects__', label: 'Projects', kind: 'header' });
    for (const p of projects) {
      items.push({ value: `p:${p.id}`, label: p.name, note: shortPath(p.path) });
    }
  }
  items.push({ value: '__add__', label: '+ Add project…' });
  return (
    <Pill
      label={label}
      items={items}
      onPick={(v) => {
        if (v === '__add__') onAdd();
        else if (v.startsWith('w:')) onPickWorkspace(v.slice(2) as UUID);
        else if (v.startsWith('p:')) onPickProject(v.slice(2) as UUID);
      }}
    />
  );
}

const RUN_MODE_LABELS: Record<RunMode, string> = {
  local: 'Work locally',
  agent: 'Run as agent',
  review: 'Review a branch',
  docs: 'Document a branch',
};

/// The run-mode menu, gated by what the current target can actually do:
/// build agents need a git repo (or a non-empty workspace), review/docs
/// need a single git repo since they check out one branch.
function runModeItems(canRunAgent: boolean, canRunDetached: boolean): PillItem[] {
  const items: PillItem[] = [
    { value: 'local', label: 'Work locally', note: 'Chat in the project directory' },
  ];
  if (canRunAgent) {
    items.push({
      value: 'agent',
      label: 'Run as agent',
      note: 'Isolated git worktree on a new branch',
    });
  }
  if (canRunDetached) {
    items.push({
      value: 'review',
      label: 'Review a branch',
      note: 'PR-style review in a detached worktree. Read-only.',
    });
    items.push({
      value: 'docs',
      label: 'Document a branch',
      note: 'User-facing docs for a branch, as markdown. Read-only.',
    });
  }
  return items;
}

function shortPath(p: string): string {
  // We don't have $HOME in the renderer (contextIsolation), so just
  // collapse any /Users/<anything>/ prefix to ~/ as a best-effort.
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}

/// Supported model suggestions per backend. Ollama is special-cased: we
/// only show models that are actually pulled locally, since the server
/// will reject anything else.
function modelOptionsFor(
  backend: Backend,
  ollamaPulled?: string[],
): string[] {
  if (backend === 'ollama') {
    return ollamaPulled ?? [];
  }
  // Single source of truth: the shared catalog. (Previously this kept a
  // hand-maintained copy, which silently went stale when a new model
  // shipped — e.g. Sonnet 5 was added to the catalog but not here.)
  return PREMIUM_MODELS[backend as Exclude<Backend, 'ollama'>];
}

interface PillItem {
  value: string;
  label: string;
  note?: string;
  kind?: 'header';
  /// When true, the row is shown greyed out and clicks are no-ops.
  /// Use `note` to explain why (e.g. "Install another CLI").
  disabled?: boolean;
}

function Pill({
  label,
  items,
  onPick,
  color,
}: {
  label: string;
  items: PillItem[];
  onPick: (v: string) => void;
  color?: string;
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
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card-strong border border-card hover:bg-card-strong text-xs whitespace-nowrap"
        style={color ? { color } : undefined}
      >
        <span>{label}</span>
        <span className="text-[9px] opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[200px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 py-1">
          {items.map((it) =>
            it.kind === 'header' ? (
              <div
                key={it.value}
                className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-ink-faint"
              >
                {it.label}
              </div>
            ) : (
              <button
                key={it.value}
                disabled={it.disabled}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  onPick(it.value);
                }}
                className={
                  'w-full text-left px-3 py-1.5 text-xs ' +
                  (it.disabled
                    ? 'opacity-40 cursor-not-allowed text-ink-muted'
                    : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                }
              >
                <div>{it.label}</div>
                {it.note && <div className="text-[10px] text-ink-faint truncate">{it.note}</div>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
