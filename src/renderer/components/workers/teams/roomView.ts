// How a team room reads once it is long: messages grouped into exchanges
// (each question you ask starts one), and what each exchange came to, for
// the one line it folds to.

import type { TeamMessage } from '@shared/flows/team';

export interface Exchange {
  n: number;
  messages: TeamMessage[];
}

export function groupExchanges(messages: TeamMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.n === m.exchange) last.messages.push(m);
    else out.push({ n: m.exchange, messages: [m] });
  }
  return out;
}

/// One line of a message, as plain text: a fold shows where it landed, not
/// the formatting.
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/// What an exchange came to, for its folded line.
export function exchangeOutcome(messages: TeamMessage[]): { kind: "landed" | "work" | "proposed" | "open"; text: string } {
  const wrap = messages.filter((m) => m.wrapUp && !m.failed).at(-1);
  if (wrap) return { kind: "landed", text: plainLine(wrap.text) };
  const reports = messages.filter((m) => m.workReport && !m.failed);
  if (reports.length > 0) {
    const who = [...new Set(reports.map((m) => (m.speaker.kind === "member" ? m.speaker.name : "")))].filter(Boolean);
    return { kind: "work", text: `${who.join(" and ")} reported back · ${plainLine(reports.at(-1)!.text)}` };
  }
  const handoff = messages.find((m) => m.handoff)?.handoff;
  if (handoff) {
    return {
      kind: "proposed",
      text: handoff.status === "dismissed" ? `Work proposed and set aside: ${handoff.title}` : `Work proposed: ${handoff.title}`,
    };
  }
  const answer = messages.filter((m) => m.speaker.kind !== "you" && !m.failed).at(-1);
  if (answer) {
    const name = answer.speaker.kind === "member" ? answer.speaker.name : "Coordinator";
    return { kind: "open", text: `${name}: ${plainLine(answer.text)}` };
  }
  return { kind: "open", text: "No answer" };
}
