// Shared "what are flows" content. Mounted as a modal from the library
// header's About button AND inlined into the empty state so a brand
// new user sees the same explanation without needing to click.

import type { ReactNode } from 'react';

export function FlowsAboutContent({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-5">
      <Block
        icon={<PipelineGlyph />}
        title="Pipelines instead of one big chat"
        body={
          <>
            A flow is a sequence of LLM steps. Each step has its own model + tools
            + role; outputs flow forward as artifacts ({box('plan.md')}, {box('diff')},
            {' '}{box('review.md')}). One participant can own several steps and
            remember context across them.
          </>
        }
      />
      <Block
        icon={<SparkGlyph />}
        title="Spend premium tokens where they count"
        body={
          <>
            Use a premium model (Claude Opus, GPT-5.5) to plan and review. Use a
            local Ollama model (qwen2.5-coder, gemma) to execute. The artifact
            handoff means no copy-paste — local sees the plan, premium sees the
            diff, you pay for premium only where it pays back.
          </>
        }
      />
      <Block
        icon={<WorktreeGlyph />}
        title="Run in a worktree, walk away"
        body={
          <>
            Optionally run a flow in a fresh git worktree off your base branch.
            Changes stay isolated until you review. Fire off a long pipeline,
            close the laptop, come back to a diff.
          </>
        }
      />
      <Block
        icon={<PauseGlyph />}
        title="Human checkpoints where they matter"
        body={
          <>
            Add {box('pause_before')} to a step (typically the shipper) and the
            flow stops for you to review the prior artifact before continuing.
            Or hijack any participant mid-flight from its tab — your messages
            don't advance the flow, they just talk to that model.
          </>
        }
      />
      <Block
        icon={<TemplateGlyph />}
        title="Templates + AI drafting"
        body={
          <>
            Start from a curated template (Solve a ticket, Add tests, Code-review
            my branch, …) or describe the flow you want and Claude drafts a YAML
            you can edit. No need to write the schema by hand.
          </>
        }
      />
      {!compact && (
        <div className="text-[11px] text-ink-faint pt-2 border-t border-card">
          Flows live as YAML in <code className="text-ink-muted">{'<userData>/flows/'}</code>
          {' '}(user-global) or <code className="text-ink-muted">{'<project>/.overcli/flows/'}</code>
          {' '}(checked into git). Project-local flows override user-global ones with the same id.
        </div>
      )}
    </div>
  );
}

function Block({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 bg-accent/10 text-accent">
        {icon}
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="text-sm font-semibold text-ink mb-1">{title}</div>
        <div className="text-[12px] text-ink-muted leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

// Monochrome line-art icons. All 16x16 viewBox, stroked with
// `stroke="currentColor"` so they inherit the accent color from their
// container. Matches WelcomePane's FeatureCard glyph style.

function PipelineGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.6 8 H6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.6 8 H11.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2 L9.4 6.6 L14 8 L9.4 9.4 L8 14 L6.6 9.4 L2 8 L6.6 6.6 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorktreeGlyph() {
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

function PauseGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.5" y="3" width="2.2" height="10" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.3" y="3" width="2.2" height="10" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function TemplateGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2 H10 L13 5 V13.5 A0.5 0.5 0 0 1 12.5 14 H3.5 A0.5 0.5 0 0 1 3 13.5 V2.5 A0.5 0.5 0 0 1 3.5 2 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M10 2 V5 H13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.5 8.5 H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.5 11 H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function box(text: string): ReactNode {
  return (
    <code className="text-[11px] px-1 py-0.5 rounded bg-card border border-card-strong font-mono">
      {text}
    </code>
  );
}

/// Modal wrapper used by the library header's About button. Empty
/// state inlines the content directly without this chrome.
export function FlowsAboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[680px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card">
          <div className="text-lg font-semibold">About flows</div>
          <button
            onClick={onClose}
            className="ml-auto text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <FlowsAboutContent />
        </div>
      </div>
    </div>
  );
}
