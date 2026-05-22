// Shared flow-launch UI, extracted from WelcomePane so the Flows library
// page and the start page render identical cards + run panels. Nothing
// here owns state — callers pass the flow, the draft key, and the
// target/worktree controls so each host stays in charge of where a run
// lands.

import type { ReactNode } from 'react';
import type { Attachment } from '@shared/types';
import type { Flow } from '@shared/flows/schema';
import { Composer } from '../Composer';
import { BaseBranchSelect } from '../sheets/BaseBranchSelect';
import { FlowMonogram } from './FlowMonogram';

/// Expanded run panel — replaces the card grid in the same vertical slot
/// so picking a flow doesn't push other content down.
export function RunPanel({
  flow,
  targetLabel,
  draftKey,
  rootPath,
  error,
  submitting,
  onCancel,
  onRun,
  canUseWorktree,
  runIn,
  onRunIn,
  baseBranch,
  onBaseBranch,
  baseBranchRepoPaths,
}: {
  flow: Flow;
  targetLabel: string;
  /// Store key the Composer reads/writes its draft + attachments under.
  draftKey: string;
  /// Project/workspace root, for @-mention file lookup in the Composer.
  rootPath: string;
  error: string | null;
  submitting: boolean;
  onCancel: () => void;
  onRun: (prompt: string, attachments: Attachment[]) => void;
  canUseWorktree: boolean;
  runIn: 'cwd' | 'worktree';
  onRunIn: (v: 'cwd' | 'worktree') => void;
  baseBranch: string;
  onBaseBranch: (s: string) => void;
  /// Repos the worktree(s) will be minted from. Single project →
  /// `[projectPath]`; workspace → each member's path. Passed straight
  /// through to `BaseBranchSelect`, which lists the branch names that
  /// exist in EVERY listed repo (intersection) so a workspace flow
  /// can't pick a branch that one member doesn't have.
  baseBranchRepoPaths: string[];
}) {
  return (
    <div
      className={
        // Solid card background — `bg-surface-elevated/60` + backdrop-blur
        // was flashing white in Electron's renderer before the CSS vars
        // settled on the first paint. Sticking to known-good tokens
        // (matching the sheet host's pattern) avoids the flicker.
        'relative rounded-2xl bg-surface-elevated ' +
        'shadow-[0_20px_60px_-20px_rgba(0,0,0,0.55),0_2px_0_0_rgba(255,255,255,0.04)_inset] ' +
        'ring-1 ring-card-strong overflow-hidden'
      }
    >
      <div className="relative p-5">
        {/* Header — monogram + title + steps, close on the right. No
            divider line; spacing alone separates from the input. */}
        <div className="flex items-start gap-3 mb-4">
          <FlowMonogram name={flow.name} size="lg" />
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="text-[15px] font-semibold leading-tight text-ink truncate">
              {flow.name}
            </div>
            <div className="text-[11px] text-ink-muted mt-1 truncate">
              <StepPreview flow={flow} />
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-faint hover:text-ink rounded-full w-7 h-7 flex items-center justify-center hover:bg-white/5 flex-shrink-0 transition"
            aria-label="Close"
            title="Back to flows"
          >
            ✕
          </button>
        </div>

        {/* Multi-line prompt with image attach / paste / drag-drop — the
            same Composer the chat uses, so a flow can be launched from a
            screenshot, spec, or log. Its send button (⏎) starts the run;
            the target + worktree controls ride in the footer. */}
        <Composer
          draftKey={draftKey}
          variant="welcome"
          autoFocus
          rootPath={rootPath}
          placeholder="What should it work on? Paste a screenshot or drop a file…"
          onSend={onRun}
          footer={
            <>
              {/* Target chip */}
              <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span className="text-ink-faint">in</span>
                <span className="font-medium text-ink truncate max-w-[140px]">{targetLabel}</span>
              </div>

              {canUseWorktree && (
                <>
                  <span className="text-ink-faint text-[11px]">·</span>
                  {/* Segmented control with a real "active" state. */}
                  <div className="inline-flex p-0.5 rounded-lg bg-card border border-card-strong">
                    <SegmentButton
                      active={runIn === 'cwd'}
                      onClick={() => onRunIn('cwd')}
                      title="Run in the project's working tree"
                    >
                      main tree
                    </SegmentButton>
                    <SegmentButton
                      active={runIn === 'worktree'}
                      onClick={() => onRunIn('worktree')}
                      title="Create a fresh worktree and run there"
                    >
                      worktree
                    </SegmentButton>
                  </div>
                  {runIn === 'worktree' && (
                    <div className="inline-flex items-center gap-1.5 text-[11px]">
                      <span className="text-ink-faint">off</span>
                      <BaseBranchSelect
                        repoPaths={baseBranchRepoPaths}
                        value={baseBranch}
                        onChange={onBaseBranch}
                        className="text-[11px]"
                      />
                    </div>
                  )}
                </>
              )}

              {submitting && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <Spinner /> Starting…
                </span>
              )}
            </>
          }
        />

        {error && (
          <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-3 whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'text-[11px] px-2.5 py-1 rounded-md transition-all ' +
        (active
          ? 'bg-accent/25 text-ink shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]'
          : 'text-ink-muted hover:text-ink hover:bg-white/5')
      }
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin w-3 h-3"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/// Single flow card in the welcome grid. Subtle resting state, lifts on
/// hover with a soft outline + tinted glow so the affordance reads as
/// clickable without shouting.
export function FlowCard({
  flow,
  picked,
  onClick,
}: {
  flow: Flow;
  picked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'group relative text-left rounded-xl border bg-card/30 px-3.5 py-3 transition-all duration-150 ' +
        'hover:bg-card/60 hover:border-accent/40 hover:-translate-y-0.5 hover:shadow-[0_4px_18px_-8px_rgba(125,200,255,0.4)] ' +
        (picked
          ? 'border-accent shadow-[0_4px_18px_-8px_rgba(125,200,255,0.5)]'
          : 'border-card')
      }
    >
      <div className="flex items-start gap-3">
        <FlowMonogram name={flow.name} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate text-ink leading-tight">
            {flow.name}
          </div>
          {flow.description && (
            <div className="text-[11px] text-ink-muted line-clamp-1 mt-1 leading-snug">
              {flow.description}
            </div>
          )}
          <div className="text-[10px] text-ink-faint mt-2 truncate">
            <StepPreview flow={flow} />
          </div>
        </div>
        {/* Subtle play arrow on hover — reinforces "click to run". */}
        <div className="text-ink-faint opacity-0 group-hover:opacity-100 group-hover:text-accent transition-opacity self-center flex-shrink-0">
          →
        </div>
      </div>
    </button>
  );
}

/// Compact "5 steps · plan → build → review" line. Truncates to 3 step
/// ids with an ellipsis for longer flows.
export function StepPreview({ flow }: { flow: Flow }) {
  const count = flow.steps.length;
  const ids = flow.steps.slice(0, 3).map((s) => s.id);
  const trail = flow.steps.length > 3 ? '…' : '';
  return (
    <>
      {count} step{count === 1 ? '' : 's'}
      {ids.length > 0 && (
        <>
          {' · '}
          <span className="text-ink-muted">{ids.join(' → ')}{trail}</span>
        </>
      )}
    </>
  );
}
