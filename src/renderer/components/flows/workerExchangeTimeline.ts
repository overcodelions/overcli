import type { FlowWorkerExchange } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';
import {
  normalizedWorkerQuestion,
  workerQuestionCandidates,
} from '@shared/flows/workerQuestion';

/// Pair persisted flow↔worker exchanges with the assistant event that asked
/// the question. Question text is the stable key across live events and CLI
/// history replay; timestamps disambiguate the rare case where a step asks the
/// same question more than once.
///
/// The candidate strings come from `workerQuestionCandidates`, which is the
/// same rule the runtime records by. Anything unmatched here renders in the
/// pane's trailing fallback list rather than inline, so a mismatch does not
/// lose the answer — it just strands it at the bottom of the transcript.
export function matchWorkerExchangesToEvents(
  events: StreamEvent[],
  exchanges: FlowWorkerExchange[],
): Map<string, FlowWorkerExchange> {
  const matched = new Map<string, FlowWorkerExchange>();
  const used = new Set<string>();
  for (const event of events) {
    if (event.kind.type !== 'assistant') continue;
    const eventQuestions = workerQuestionCandidates(event.kind.info.text);
    if (eventQuestions.length === 0) continue;
    const candidates = exchanges
      .filter(
        (exchange) =>
          !used.has(exchange.id) &&
          eventQuestions.some(
            (question) =>
              normalizedWorkerQuestion(question) === normalizedWorkerQuestion(exchange.question),
          ),
      )
      .sort(
        (a, b) =>
          Math.abs(a.askedAt - event.timestamp) - Math.abs(b.askedAt - event.timestamp),
      );
    const exchange = candidates[0];
    if (!exchange) continue;
    used.add(exchange.id);
    matched.set(event.id, exchange);
  }
  return matched;
}
