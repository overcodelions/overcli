// A flow step hands its deliverable to the next step either inline, inside
// `<output name="…">…</output>`, or — when the run already wrote it to a file
// — as a bare pointer: `<output name="report.md" file="draft.md" />`. The
// pointer form is what the missing-output re-ask explicitly asks for, so a
// whole reply that is nothing but the tag is the *successful* shape, not a
// malformed one. It has no prose to render, though, so left alone it shows up
// as an empty assistant bubble.
//
// This parser recognizes that reply so the bubble can say what was handed
// over instead of showing nothing.

export interface OutputHandoff {
  /// The `name` the step declared for its deliverable.
  name: string;
  /// The file the pointer names, or null for an empty inline block.
  file: string | null;
}

// One `<output …>` tag, optionally self-closing or immediately closed, with
// nothing else in the reply.
const LONE_OUTPUT_TAG_RE = /^<output\b([^>]*?)\/?>(?:\s*<\/output\s*>)?$/i;

/// Parse a reply that consists of a single `<output>` tag and nothing else.
/// Returns null for any reply with prose, a body, or no tag at all — those
/// render normally.
export function parseOutputHandoff(text: string): OutputHandoff | null {
  const match = LONE_OUTPUT_TAG_RE.exec(text.trim());
  if (!match) return null;
  const name = attr(match[1], 'name');
  if (!name) return null;
  return { name, file: attr(match[1], 'file') };
}

/// Read one attribute out of a tag's attribute text. Tolerant of either
/// quote style and of attributes in any order, since this is model output
/// rather than a document we generated.
function attr(attrs: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  const value = (m[2] ?? m[3] ?? '').trim();
  return value.length > 0 ? value : null;
}
