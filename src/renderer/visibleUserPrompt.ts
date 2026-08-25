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
  if (rest.startsWith(BATCHING_DIRECTIVE)) {
    rest = rest.slice(BATCHING_DIRECTIVE.length).trimStart();
  }
  const attachmentSummary = attachmentsRendered
    ? ''
    : imageLabels.map((label) => `Attached: ${label}`).join('\n');
  return [attachmentSummary, rest].filter(Boolean).join('\n');
}
