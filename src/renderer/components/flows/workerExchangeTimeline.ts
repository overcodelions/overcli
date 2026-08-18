import type { FlowWorkerExchange } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';

/// Pair persisted flow↔worker exchanges with the assistant event that asked
/// the question. Question text is the stable key across live events and CLI
/// history replay; timestamps disambiguate the rare case where a step asks the
/// same question more than once.
export function matchWorkerExchangesToEvents(
  events: StreamEvent[],
  exchanges: FlowWorkerExchange[],
): Map<string, FlowWorkerExchange> {
  const matched = new Map<string, FlowWorkerExchange>();
  const used = new Set<string>();
  for (const event of events) {
    if (event.kind.type !== 'assistant') continue;
    const eventQuestions = workerQuestionsInAssistantText(event.kind.info.text);
    if (eventQuestions.length === 0) continue;
    const candidates = exchanges
      .filter(
        (exchange) =>
          !used.has(exchange.id) &&
          eventQuestions.some(
            (question) => normalizedQuestion(question) === normalizedQuestion(exchange.question),
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

function workerQuestionsInAssistantText(text: string): string[] {
  const tagged = [
    ...text.matchAll(/<worker_question\b[^>]*>([\s\S]*?)<\/worker_question\s*>/gi),
  ]
    .map((match) => match[1]?.trim())
    .filter((question): question is string => !!question);
  if (tagged.length > 0) return tagged;
  const cleaned = text.replace(/<[^>]+>/g, '').trim();
  return cleaned.endsWith('?') ? [cleaned] : [];
}

function normalizedQuestion(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}
