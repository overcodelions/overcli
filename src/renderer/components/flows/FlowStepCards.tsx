// Renders a flow step's turn as a centered "system" card — distinct from a
// user turn (right) or an agent turn (left). The flow driver, not the human,
// is speaking, so it reads as a system event in the transcript.
//
// The card has three optional parts: a header (step title / "picking up"
// note), a collapsible Instructions disclosure (the role's system prompt,
// verbatim — answering "how does this step know what to do?"), and the
// inputs handed to the step, rendered as markdown. Both the live (markered)
// and reloaded (raw prompt) forms are normalized by parseFlowStepContent.

import { useMemo, useState } from 'react';
import { Markdown } from '../Markdown';
import { parseFlowStepContent } from './flowStepSections';

export function FlowStepCards({ text }: { text: string }) {
  const content = useMemo(() => parseFlowStepContent(text), [text]);

  // Not actually a flow step (or unparseable) — show the text plainly so we
  // never swallow a turn.
  if (!content) {
    return (
      <div className="flex justify-center">
        <div className="w-full max-w-[820px] rounded-xl border border-card-strong bg-card/30 px-3.5 py-2 text-sm whitespace-pre-wrap select-text">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center my-1">
      <div className="w-full max-w-[820px] rounded-xl border border-card-strong bg-card/25 overflow-hidden select-text shadow-sm">
        {/* Label strip — marks this as a flow-driven system turn. */}
        <div className="px-3 py-1.5 border-b border-card-strong/60 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-white/[0.015]">
          <span>⚙ Flow step</span>
          {content.title && (
            <span className="text-ink-muted normal-case tracking-normal">· {content.title}</span>
          )}
        </div>

        {content.headerMarkdown && (
          <div className="px-3.5 py-2 text-sm">
            <Markdown source={content.headerMarkdown} />
          </div>
        )}

        {content.instructions && <InstructionsDisclosure content={content.instructions} />}

        {content.inputsMarkdown && (
          <div className="px-3.5 py-2 text-sm border-t border-card-strong/40">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
              Inputs
            </div>
            {/* Cap tall inputs (a big plan or diff) so the card stays
                scannable; the body scrolls within. */}
            <div className="max-h-[55vh] overflow-auto">
              <Markdown source={content.inputsMarkdown} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The system prompt, quieter than the rest: collapsed by default (it's
// reference material) and rendered preformatted so the prompt's literal
// indentation and `-`/`*` bullets survive instead of being reinterpreted by
// the markdown parser.
function InstructionsDisclosure({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-card-strong/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.02]"
      >
        <span className="text-[11px] text-ink-faint">{open ? '▼' : '▶'}</span>
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">
          Instructions given to the model
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-2 text-xs font-mono whitespace-pre-wrap text-ink-muted max-h-[50vh] overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}
