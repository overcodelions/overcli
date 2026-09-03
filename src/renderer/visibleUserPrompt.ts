import { BATCHING_DIRECTIVE } from '@shared/turbo';

const LEADING_IMAGE_TAG = /^\s*<image\s+name=\[([^\]]+)\]\s+path="[^"]*"\s*>\s*<\/image>/i;

/// Remove transport-only scaffolding from a normal user bubble. The raw event
/// remains untouched for model input and Debug → Stream; this is display-only.
export function visibleUserPrompt(text: string, attachmentsRendered = false): string {
  let rest = text;
  const imageLabels: string[] = [];
  while (true) {
    const match = rest.match(LEADING_IMAGE_TAG);
    if (!match) break;
    imageLabels.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  rest = rest.trimStart();
  // The directive is appended now, but conversations recorded before that
  // change carry it in front, so both ends stay strippable. The trailing form
  // arrives behind a `---` rule; drop that too, or every codex bubble ends in
  // a stray horizontal line.
  if (rest.startsWith(BATCHING_DIRECTIVE)) {
    rest = rest.slice(BATCHING_DIRECTIVE.length).trimStart();
  }
  if (rest.endsWith(BATCHING_DIRECTIVE)) {
    rest = rest.slice(0, -BATCHING_DIRECTIVE.length).trimEnd();
    if (rest.endsWith('---')) rest = rest.slice(0, -3).trimEnd();
  }
  const attachmentSummary = attachmentsRendered
    ? ''
    : imageLabels.map((label) => `Attached: ${label}`).join('\n');
  return [attachmentSummary, rest].filter(Boolean).join('\n');
}
