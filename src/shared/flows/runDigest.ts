// A worker run's own account of what it achieved, for the Today digest.
//
// A worker's final step is asked to end with a one-line `<headline>` (and,
// optionally, a `<summary>` sentence and 1–3 `<points>`) AFTER its
// `<output>` block — the result in the worker's words, which a heuristic
// reading of the deliverable can only approximate. The runtime records it on
// the run; the renderer prefers it and falls back to the deliverable when a
// run has none, which is every run from before this existed.

import type { FlowRunDigest } from './schema';

const MAX_HEADLINE = 160;
const MAX_SUMMARY = 300;
const MAX_POINT = 200;

/// The instruction appended to a worker run's final step.
export const RUN_DIGEST_INSTRUCTION = [
  'AFTER your </output> block, for the user\'s daily digest, add:',
  '<headline>one line: what you found or did — the result, not the task</headline>',
  'and, if there are facts worth seeing at a glance, up to three:',
  '<points>',
  '- a key fact',
  '</points>',
  'Keep both outside <output>. Plain text, no markdown.',
].join('\n');

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/// The digest a step's text carries, or null when it wrote no headline.
/// Tags inside the `<output>` block are ignored: those belong to the
/// deliverable, which may legitimately be a document ABOUT headlines.
export function parseRunDigest(text: string): FlowRunDigest | null {
  const outside = text.replace(/<output\b[\s\S]*?<\/output>/gi, ' ');
  const headline = outside.match(/<headline>([\s\S]*?)<\/headline>/i)?.[1];
  if (!headline?.trim()) return null;
  const summary = outside.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1];
  const points = (outside.match(/<points>([\s\S]*?)<\/points>/i)?.[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((p) => clip(p, MAX_POINT));
  return {
    headline: clip(headline, MAX_HEADLINE),
    ...(summary?.trim() ? { summary: clip(summary, MAX_SUMMARY) } : {}),
    ...(points.length > 0 ? { points } : {}),
  };
}
