import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Backend, Conversation, UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { BaseBranchSelect } from './BaseBranchSelect';
import { WorktreeCreatingStatus } from '../WorktreeCreatingStatus';

type AgentKind = 'build' | 'review' | 'docs';

interface KindMeta {
  id: AgentKind;
  label: string;
  summary: string;
}

// Extensible registry — add 'security', 'perf', etc. here.
const KINDS: KindMeta[] = [
  {
    id: 'build',
    label: 'Build',
    summary: 'Spins up a git worktree on a new branch so the agent can make changes.',
  },
  {
    id: 'review',
    label: 'Review',
    summary: 'Checks out an existing branch in a detached worktree and runs a PR-style review. Non-destructive.',
  },
  {
    id: 'docs',
    label: 'Docs',
    summary: 'Reads a feature branch (non-destructively) and writes user-facing documentation for it as markdown in chat. No commits, no file edits.',
  },
];

export function NewAgentSheet({ projectId }: { projectId: UUID }) {
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const saveProjects = useStore((s) => s.saveProjects);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);
  const send = useStore((s) => s.send);
  const project = projects.find((p) => p.id === projectId);

  const [kind, setKind] = useState<AgentKind>('build');
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchLock = useRef(false);

  const needsTargetBranch = kind === 'review' || kind === 'docs';

  useEffect(() => {
    if (!project || !needsTargetBranch) return;
    let cancelled = false;
    setLoadingBranches(true);
    void window.overcli
      .invoke('git:listBaseBranches', project.path)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.path, needsTargetBranch]);

  const targetBranchOptions = useMemo(
    () => branches.filter((b) => b !== baseBranch),
    [branches, baseBranch],
  );

  useEffect(() => {
    if (!needsTargetBranch) return;
    if (targetBranch || targetBranchOptions.length === 0) return;
    setTargetBranch(targetBranchOptions[0]);
  }, [needsTargetBranch, targetBranch, targetBranchOptions]);

  if (!project) return null;
  const preferredBackend = firstEnabledBackend(settings);

  const needsName = kind === 'build';
  const canSubmit =
    !working &&
    !!baseBranch &&
    (needsTargetBranch ? !!targetBranch : !!name.trim());

  const submitLabel = working
    ? kind === 'review'
      ? 'Starting review…'
      : kind === 'docs'
        ? 'Drafting docs…'
        : 'Creating…'
    : kind === 'review'
      ? 'Start review'
      : kind === 'docs'
        ? 'Draft docs'
        : 'Create';

  const go = async () => {
    if (launchLock.current || !canSubmit) return;
    launchLock.current = true;
    setWorking(true);
    setError(null);
    try {
      const onCreated = async (convId: UUID, initialPrompt: string | null) => {
        await saveProjects();
        selectConversation(convId);
        openSheet(null);
        if (initialPrompt) await send(convId, initialPrompt);
      };
      if (kind === 'review' || kind === 'docs') {
        await createDetachedAgent({
          kind,
          project,
          projectId,
          settings,
          preferredBackend,
          targetBranch,
          baseBranch,
          onError: setError,
          onCreated,
        });
      } else {
        await createBranchedAgent({
          project,
          projectId,
          settings,
          preferredBackend,
          name: name.trim(),
          baseBranch,
          onError: setError,
          onCreated: async (convId) => onCreated(convId, null),
        });
      }
    } finally {
      launchLock.current = false;
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">New agent</div>
        <div className="text-xs text-ink-faint">{kindMeta(kind).summary}</div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Kind</label>
        <div className="flex gap-1 rounded border border-card bg-card p-1 w-fit">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={
                'text-xs px-3 py-1 rounded transition-colors ' +
                (kind === k.id
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-ink-muted hover:bg-card-strong hover:text-ink')
              }
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {needsName ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-faint">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="refactor-payments"
            className="field px-3 py-1.5 text-sm"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-faint">
            {kind === 'docs' ? 'Branch to document' : 'Branch to review'}
          </label>
          <select
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            disabled={loadingBranches || targetBranchOptions.length === 0}
            className="field px-3 py-1.5 text-sm"
          >
            {targetBranchOptions.length === 0 ? (
              <option value="">
                {loadingBranches ? 'Loading branches…' : 'No branches available'}
              </option>
            ) : (
              targetBranchOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))
            )}
          </select>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">
          {needsTargetBranch ? 'Compare against (base)' : 'Base branch'}
        </label>
        <BaseBranchSelect repoPaths={[project.path]} value={baseBranch} onChange={setBaseBranch} />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {working && (
        <WorktreeCreatingStatus
          message={
            kind === 'review'
              ? 'Checking out review worktree…'
              : kind === 'docs'
                ? 'Checking out docs worktree…'
                : 'Creating worktree…'
          }
        />
      )}
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={submitLabel}
          disabled={!canSubmit}
          onClick={() => void go()}
        />
      </div>
    </div>
  );
}

interface CreateCtx {
  project: { id: UUID; path: string; name: string };
  projectId: UUID;
  settings: ReturnType<typeof useStore.getState>['settings'];
  preferredBackend: Backend;
  onError: (msg: string) => void;
}

async function createBranchedAgent(
  args: CreateCtx & {
    name: string;
    baseBranch: string;
    onCreated: (convId: UUID) => Promise<void>;
  },
): Promise<void> {
  const agentName = slugify(args.name);
  if (!agentName) return;
  const res = await window.overcli.invoke('git:createWorktree', {
    projectPath: args.project.path,
    agentName,
    baseBranch: args.baseBranch,
    branchPrefix: args.settings.agentBranchPrefix,
  });
  if (!res.ok) {
    args.onError(res.error);
    return;
  }
  const convId = crypto.randomUUID();
  const conv: Conversation = {
    id: convId,
    name: args.name,
    createdAt: Date.now(),
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: '',
    permissionMode: args.settings.defaultPermissionMode,
    primaryBackend: args.preferredBackend,
    worktreePath: res.worktreePath,
    branchName: res.branchName,
    baseBranch: args.baseBranch,
  };
  useStore.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === args.projectId ? { ...p, conversations: [...p.conversations, conv] } : p,
    ),
  }));
  await args.onCreated(convId);
}

/// Shared path for review + docs: both spawn a detached-HEAD worktree at
/// the target branch and auto-fire a read-only first turn. The only
/// difference is the label, the slug prefix, and the prompt builder.
async function createDetachedAgent(
  args: CreateCtx & {
    kind: 'review' | 'docs';
    targetBranch: string;
    baseBranch: string;
    onCreated: (convId: UUID, initialPrompt: string) => Promise<void>;
  },
): Promise<void> {
  const displayBranch = stripOriginPrefix(args.targetBranch);
  const agentName = `${args.kind}-${slugify(displayBranch) || args.kind}`;
  const res = await window.overcli.invoke('git:createReviewWorktree', {
    projectPath: args.project.path,
    agentName,
    targetBranch: args.targetBranch,
  });
  if (!res.ok) {
    args.onError(res.error);
    return;
  }
  const convId = crypto.randomUUID();
  const conv: Conversation = {
    id: convId,
    name: `${args.kind} · ${displayBranch}`,
    createdAt: Date.now(),
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: '',
    permissionMode: args.settings.defaultPermissionMode,
    primaryBackend: args.preferredBackend,
    worktreePath: res.worktreePath,
    baseBranch: args.baseBranch,
    reviewAgent: true,
    reviewAgentKind: args.kind,
    reviewTargetBranch: args.targetBranch,
  };
  useStore.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === args.projectId ? { ...p, conversations: [...p.conversations, conv] } : p,
    ),
  }));
  const prompt =
    args.kind === 'docs'
      ? buildDocsPrompt({ targetBranch: displayBranch, baseBranch: args.baseBranch })
      : buildReviewPrompt({ targetBranch: displayBranch, baseBranch: args.baseBranch });
  await args.onCreated(convId, prompt);
}

function kindMeta(id: AgentKind): KindMeta {
  return KINDS.find((k) => k.id === id) ?? KINDS[0];
}

function buildDocsPrompt(args: { targetBranch: string; baseBranch: string }): string {
  return [
    `You are a documentation agent. The feature you're documenting lives on branch \`${args.targetBranch}\`; compare against \`${args.baseBranch}\` to identify what's new.`,
    `You are running inside a detached-HEAD git worktree at the tip of \`${args.targetBranch}\`. **Do not edit files and do not commit.** Output everything as markdown in this chat.`,
    ``,
    `Investigate first:`,
    ``,
    `1. \`git log ${args.baseBranch}..HEAD --oneline\` to see the commits.`,
    `2. \`git diff ${args.baseBranch}...HEAD\` to see the changes.`,
    `3. Read the touched files and any adjacent code needed for context.`,
    ``,
    `Then produce **user-facing documentation** for what this feature adds. Structure:`,
    ``,
    `- **Overview** — what the feature is and why it exists, in plain language (2–4 sentences).`,
    `- **How to use it** — the steps an end user follows, with concrete examples (CLI snippets, screenshots of intent, config values — whatever the feature surface calls for).`,
    `- **Configuration / options** — every user-facing setting or flag the feature exposes. Name, default, effect.`,
    `- **What changed for existing users** — migration notes, behavior deltas, anything that could surprise someone who knew the old flow.`,
    `- **Limitations & known edge cases** — what it doesn't do, rough edges, follow-up work the code comments or commits hint at.`,
    ``,
    `Write for end users of the product, not contributors. Keep it in markdown, well-formatted, skimmable. You can adjust the sections above if the feature genuinely doesn't fit them — prefer clarity over template adherence.`,
  ].join('\n');
}

function buildReviewPrompt(args: { targetBranch: string; baseBranch: string }): string {
  return [
    `You are reviewing branch \`${args.targetBranch}\` against \`${args.baseBranch}\`.`,
    `You are running inside a detached-HEAD git worktree checked out at the tip of \`${args.targetBranch}\`.`,
    ``,
    `Do a thorough PR-style review:`,
    ``,
    `1. Run \`git log ${args.baseBranch}..HEAD --oneline\` to list commits.`,
    `2. Run \`git diff ${args.baseBranch}...HEAD\` to see the full diff.`,
    `3. Read the changed files for context as needed.`,
    ``,
    `Then produce a review with these sections:`,
    ``,
    `- **Summary** — what changed and the apparent intent (2–4 sentences).`,
    `- **Correctness & risk** — bugs, edge cases, concurrency/ordering issues, null-safety, error handling. Cite file:line.`,
    `- **App-wide impact** — what other parts of the codebase this touches or could break; migration/compat concerns; performance implications.`,
    `- **Test coverage** — do the changes have tests? Are the tests meaningful? Gaps worth flagging?`,
    `- **Style / maintainability** — only non-trivial issues (skip nits unless they obscure intent).`,
    `- **Verdict** — one of: ✅ approve · 🟡 approve with suggestions · 🔴 request changes. One-sentence justification.`,
    ``,
    `Be specific and reference file:line. Don't edit anything — this is a review, not a fix.`,
  ].join('\n');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function stripOriginPrefix(branch: string): string {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
}

function firstEnabledBackend(settings: {
  disabledBackends?: Partial<Record<Backend, boolean>>;
  preferredBackend?: Backend;
}): Backend {
  const all: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];
  const enabled = all.filter((b) => settings.disabledBackends?.[b] !== true);
  const preferred = settings.preferredBackend;
  if (preferred && enabled.includes(preferred)) return preferred;
  return enabled[0] ?? 'claude';
}
