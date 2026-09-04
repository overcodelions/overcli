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

/// Where each exchange belongs in the rendered transcript.
export interface WorkerExchangePlacement {
  /// Exchanges to draw immediately after a given event, in ask order.
  byEventId: Map<string, FlowWorkerExchange[]>;
  /// Ids of the exchanges matched to the message that actually asked the
  /// question, as opposed to the ones merely dropped in at the right moment.
  /// The bubble repeats the question for the latter, since the asking turn
  /// isn't necessarily above it.
  anchored: Set<string>;
  /// Asked before anything in the transcript we hold, so they belong ABOVE
  /// it. Replayed history is a tail — `HISTORY_TAIL_BUDGET_BYTES` drops the
  /// front of a large transcript — and a run that stalled on a question early
  /// in a long session is exactly the case where the asking turn has been
  /// trimmed away. They used to go to the bottom of the pane, which put the
  /// oldest thing in the conversation underneath the newest.
  leading: FlowWorkerExchange[];
}

/// Whether an exchange bubble can be hung off this event.
///
/// `renderAfterEvent` only fires for events ChatView actually draws, so an
/// anchor has to be one that survives its filtering whatever the user's
/// tool-activity setting is: a message someone typed, or an assistant turn
/// with text in it. Anchoring to a tool result the user has hidden would not
/// move the bubble — it would delete it.
function isAnchorable(event: StreamEvent): boolean {
  if (event.kind.type === 'localUser') return true;
  return event.kind.type === 'assistant' && event.kind.info.text.trim().length > 0;
}

/// Place every exchange in the transcript.
///
/// Matching by question text is still the first choice — it puts the reply
/// directly under the turn that asked. What changed is the fallback: an
/// unmatched exchange used to be appended to a trailing list at the very
/// bottom of the pane, which reads as correct exactly once. The moment
/// anything else arrives — the model's next message, or a reply the user
/// types — the card is left floating below work that happened after it, and a
/// person who answers the question watches their own message land ABOVE the
/// question. So an unmatched exchange now anchors to the last thing that was
/// already on screen when it was asked, and stays there.
///
/// Matching fails more often than it looks like it should, and not because
/// the text drifted: a long session's replayed history is only its last
/// ~1.5MB (`HISTORY_TAIL_BUDGET_BYTES`), so the turn that asked can simply be
/// missing from `events`. That case lands in `leading` — above the transcript,
/// where it happened — rather than after it.
export function placeWorkerExchanges(
  events: StreamEvent[],
  exchanges: FlowWorkerExchange[],
): WorkerExchangePlacement {
  const matched = matchWorkerExchangesToEvents(events, exchanges);
  const byEventId = new Map<string, FlowWorkerExchange[]>();
  const anchored = new Set<string>();
  const push = (eventId: string, exchange: FlowWorkerExchange) => {
    const list = byEventId.get(eventId);
    if (list) list.push(exchange);
    else byEventId.set(eventId, [exchange]);
  };
  for (const [eventId, exchange] of matched) {
    push(eventId, exchange);
    anchored.add(exchange.id);
  }
  const leading: FlowWorkerExchange[] = [];
  for (const exchange of [...exchanges].sort((a, b) => a.askedAt - b.askedAt)) {
    if (anchored.has(exchange.id)) continue;
    // Array order, not timestamp order: this picks the anchor the reader will
    // see it under, and the transcript is drawn in the order it is held.
    let anchor: StreamEvent | null = null;
    for (const event of events) {
      if (event.timestamp > exchange.askedAt) continue;
      if (isAnchorable(event)) anchor = event;
    }
    if (anchor) push(anchor.id, exchange);
    else leading.push(exchange);
  }
  return { byEventId, anchored, leading };
}
