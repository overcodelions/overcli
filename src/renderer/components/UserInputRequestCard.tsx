import { useEffect, useState } from 'react';
import { UserInputQuestion, UserInputRequestInfo, UUID } from '@shared/types';
import { useStore } from '../store';

const OTHER_OPTION_LABEL = 'None of the above';
const OTHER_OPTION_DESCRIPTION = 'Optionally add details below.';

export function UserInputRequestCard({
  info,
  conversationId,
}: {
  info: UserInputRequestInfo;
  conversationId: UUID;
}) {
  const respondUserInput = useStore((s) => s.respondUserInput);
  const [selections, setSelections] = useState<Record<number, number | null>>(() =>
    defaultSelections(info.questions),
  );
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(!!info.submitted);

  useEffect(() => {
    if (info.submitted) setSubmitted(true);
  }, [info.submitted]);

  const submit = () => {
    if (submitted || info.questions.length === 0) return;
    const answers: Record<string, { answers: string[] }> = {};
    info.questions.forEach((question, idx) => {
      const answerList: string[] = [];
      const selectedIdx = selections[idx];
      const selectedLabel =
        selectedIdx == null ? null : optionLabelForIndex(question, selectedIdx);
      if (selectedLabel) answerList.push(selectedLabel);
      const note = (notes[idx] ?? '').trim();
      if (note) answerList.push(`user_note: ${note}`);
      answers[question.id] = { answers: answerList };
    });
    setSubmitted(true);
    void respondUserInput(conversationId, info.requestId, answers);
  };

  return (
    <div className="rounded-lg border border-blue-500/35 bg-blue-500/15 dark:bg-blue-500/[0.12] text-xs">
      <div className="px-3 py-1.5 border-b border-blue-500/30 text-[10px] uppercase tracking-wide text-blue-800 dark:text-blue-200 font-semibold">
        Assistant is asking
      </div>
      <div className="px-3 py-2 flex flex-col gap-3">
        {info.questions.length === 0 ? (
          <div className="text-[10px] text-ink-faint italic">(question still streaming…)</div>
        ) : (
          info.questions.map((question, qi) => {
            const options = effectiveOptions(question);
            const hasOptions = options.length > 0;
            return (
              <div key={question.id || qi} className="flex flex-col gap-1.5">
                <div className="text-ink">{question.header || question.question || `Question ${qi + 1}`}</div>
                {question.question && question.question !== question.header && (
                  <div className="text-[10px] text-ink-faint">{question.question}</div>
                )}
                {hasOptions && (
                  <div className="flex flex-col gap-1">
                    {options.map((option, oi) => {
                      const picked = selections[qi] === oi;
                      return (
                        <button
                          key={`${question.id}-${oi}`}
                          disabled={submitted}
                          onClick={() => setSelections((cur) => ({ ...cur, [qi]: oi }))}
                          className={
                            'text-left px-2.5 py-1.5 rounded border flex items-start gap-2 ' +
                            (picked
                              ? 'border-blue-500 bg-blue-500/25'
                              : 'border-transparent bg-blue-500/5 hover:bg-blue-500/15') +
                            (submitted ? ' opacity-50 cursor-not-allowed' : '')
                          }
                        >
                          <div
                            className={
                              'mt-0.5 w-3 h-3 flex-shrink-0 rounded-full border ' +
                              (picked ? 'border-blue-500 bg-blue-500' : 'border-blue-500/50')
                            }
                          />
                          <div className="flex-1">
                            <div className="text-ink">{option.label}</div>
                            {option.description && (
                              <div className="text-[10px] text-ink-faint">{option.description}</div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {question.isSecret ? (
                  <input
                    type="password"
                    value={notes[qi] ?? ''}
                    disabled={submitted}
                    onChange={(e) => setNotes((cur) => ({ ...cur, [qi]: e.target.value }))}
                    placeholder={hasOptions ? 'Add notes (optional)' : 'Type your answer (optional)'}
                    className="px-2.5 py-1.5 rounded border border-blue-500/30 bg-blue-500/5 text-ink placeholder:text-ink-faint outline-none focus:border-blue-500"
                  />
                ) : (
                  <textarea
                    value={notes[qi] ?? ''}
                    disabled={submitted}
                    onChange={(e) => setNotes((cur) => ({ ...cur, [qi]: e.target.value }))}
                    placeholder={hasOptions ? 'Add notes (optional)' : 'Type your answer (optional)'}
                    rows={hasOptions ? 2 : 3}
                    className="px-2.5 py-1.5 rounded border border-blue-500/30 bg-blue-500/5 text-ink placeholder:text-ink-faint outline-none focus:border-blue-500 resize-y min-h-[56px]"
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-blue-500/30">
        {submitted ? (
          <span className="text-[10px] text-blue-300">Answer sent</span>
        ) : (
          <button
            onClick={submit}
            disabled={info.questions.length === 0}
            className="text-xs px-3 py-1 rounded bg-blue-500/25 text-blue-100 hover:bg-blue-500/40 disabled:opacity-40"
          >
            Submit
          </button>
        )}
      </div>
    </div>
  );
}

function defaultSelections(questions: UserInputQuestion[]): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  questions.forEach((question, idx) => {
    out[idx] = effectiveOptions(question).length > 0 ? 0 : null;
  });
  return out;
}

function effectiveOptions(question: UserInputQuestion): Array<{ label: string; description?: string }> {
  const options = [...(question.options ?? [])];
  if (question.isOther && options.length > 0) {
    options.push({ label: OTHER_OPTION_LABEL, description: OTHER_OPTION_DESCRIPTION });
  }
  return options;
}

function optionLabelForIndex(question: UserInputQuestion, idx: number): string | null {
  const option = effectiveOptions(question)[idx];
  return option?.label ?? null;
}
