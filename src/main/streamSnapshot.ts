// Pure helpers that operate on streamed CLI output: collapsing partial
// assistant snapshots before they hit the IPC bus, and pulling the
// current text/thinking out of a `codex exec` console buffer.

import { StreamEvent } from '../shared/types';

/// Drop all but the last partial-assistant snapshot per event id in the
/// batch. Non-partial events (tool results, the final assistant, etc)
/// pass through untouched. Preserves order so throttled streaming still
/// feels live while the IPC bus carries at most one payload per id per
/// stdout chunk.
export function collapsePartialAssistants(events: StreamEvent[]): StreamEvent[] {
  const latestPartialIdx = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind.type === 'assistant' && e.kind.info.isPartial) {
      latestPartialIdx.set(e.id, i);
    }
  }
  if (latestPartialIdx.size === 0) return events;
  const out: StreamEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind.type === 'assistant' && e.kind.info.isPartial) {
      if (latestPartialIdx.get(e.id) === i) out.push(e);
    } else {
      out.push(e);
    }
  }
  return out;
}

export function extractCodexExecSnapshot(raw: string): { text: string; thinking: string } {
  if (!raw.trim()) return { text: '', thinking: '' };

  // Timestamped blocks (newer codex exec):
  // [2026-... ] thinking
  // <body>
  // [2026-... ] codex
  // <body>
  const tsLine = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\][ \t]*(.*?)[ \t]*$/gm;
  const sections: Array<{ tag: string; bodyStart: number; markerStart: number }> = [];
  for (const m of raw.matchAll(tsLine)) {
    const idx = m.index ?? 0;
    sections.push({ tag: (m[1] ?? '').trim().toLowerCase(), bodyStart: idx + m[0].length, markerStart: idx });
  }
  if (sections.length > 0) {
    const textBlocks: string[] = [];
    const thinkingBlocks: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const cur = sections[i]!;
      const end = sections[i + 1]?.markerStart ?? raw.length;
      const body = raw.slice(cur.bodyStart, end).trim();
      if (!body) continue;
      if (cur.tag === 'codex') textBlocks.push(body);
      else if (cur.tag.includes('thinking') || cur.tag.includes('reasoning')) thinkingBlocks.push(body);
    }
    const text = textBlocks.join('\n\n').trim();
    const thinking = thinkingBlocks.join('\n\n').trim();
    if (text || thinking) return { text, thinking };
  }

  // Plain sections (older/alternate codex exec):
  // thinking\n...\n
  // codex\n...\n
  const thinking = extractSection(raw, 'thinking').trim();
  const text = extractSection(raw, 'codex').trim();
  if (text || thinking) return { text, thinking };

  // Last resort: avoid dumping headers/config in the chat bubble.
  return { text: raw.trim(), thinking: '' };
}

function extractSection(raw: string, label: string): string {
  const re = new RegExp(
    String.raw`(?:^|\r?\n)${label}\r?\n([\s\S]*?)(?=(?:\r?\n(?:tokens used|user|codex|thinking|reasoning)\r?\n)|$)`,
    'i',
  );
  const m = raw.match(re);
  return m?.[1] ?? '';
}
