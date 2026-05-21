// Parsers that turn a flow step's "user" turn into the pieces FlowStepCards
// renders. A flow turn reaches the renderer in one of two shapes:
//
//   1. LIVE — the runtime emits a cleaned-up display text prefixed with
//      `<!--flow-->` and split into `<!--flow:header|instructions|inputs-->`
//      sections (see buildStepDisplayText in src/main/flows/runtime.ts).
//   2. RELOADED — after a restart the transcript is rebuilt from the CLI's
//      JSONL, which only recorded the raw MODEL prompt (buildStepPrompt).
//      That prompt has no markers, so we parse its known structure instead.
//
// Both collapse to the same FlowStepContent so the card renders identically.

export type FlowSectionKind = 'header' | 'instructions' | 'inputs';

export interface FlowSection {
  kind: FlowSectionKind;
  content: string;
}

export interface FlowStepContent {
  /// Markdown for the header card (live path: "### Step: …" + an optional
  /// "picking up" continuation note). Null on the reloaded path.
  headerMarkdown: string | null;
  /// Short label shown in the card's strip when there's no header markdown
  /// (reloaded path), e.g. "reviewer step".
  title: string | null;
  /// The role's instructions, verbatim. Rendered preformatted so the
  /// prompt's indentation and bullets survive. Null when none were found.
  instructions: string | null;
  /// The step's inputs as one markdown blob (headings + fenced bodies).
  inputsMarkdown: string | null;
}

const FLOW_DISPLAY_MARKER = '<!--flow-->';
const SECTION_RE = /<!--flow:(header|instructions|inputs)-->/g;

// Unique tail of every step prompt buildStepPrompt produces — used to
// recognize a reloaded flow turn that lost its display markers.
const RAW_PROMPT_SIGNATURE = /wrap your final deliverable in <output name=/;

// Boundary strings that must stay in sync with buildStepPrompt /
// artifactInstruction in the main process.
const OUTPUT_CONTRACT_HEADING = 'IMPORTANT — output contract:';
const INPUTS_DELIMITER = '\n\n---\n\nINPUTS:\n\n';
const PROCEED_DELIMITER = '\n\n---\n\nProceed with your task now.';

/// True for either a live (markered) or reloaded (raw) flow step turn.
export function isFlowStepTurn(text: string): boolean {
  return text.startsWith(FLOW_DISPLAY_MARKER) || RAW_PROMPT_SIGNATURE.test(text);
}

/// Split a marker-delimited body into ordered sections. Text before the
/// first marker is ignored. Returns an empty array when no markers are
/// present, so callers can fall back to the raw-prompt parser.
export function parseFlowSections(body: string): FlowSection[] {
  const sections: FlowSection[] = [];
  let match: RegExpExecArray | null;
  let kind: FlowSectionKind | null = null;
  let start = 0;
  SECTION_RE.lastIndex = 0;
  while ((match = SECTION_RE.exec(body)) !== null) {
    if (kind !== null) {
      sections.push({ kind, content: body.slice(start, match.index).trim() });
    }
    kind = match[1] as FlowSectionKind;
    start = SECTION_RE.lastIndex;
  }
  if (kind !== null) {
    sections.push({ kind, content: body.slice(start).trim() });
  }
  return sections;
}

/// Resolve a flow step turn (either shape) into renderable content. Returns
/// null when the text isn't a flow step turn at all.
export function parseFlowStepContent(text: string): FlowStepContent | null {
  if (text.startsWith(FLOW_DISPLAY_MARKER)) {
    return fromMarkers(text.slice(FLOW_DISPLAY_MARKER.length).trimStart());
  }
  if (RAW_PROMPT_SIGNATURE.test(text)) {
    return fromRawPrompt(text);
  }
  return null;
}

function fromMarkers(body: string): FlowStepContent {
  const sections = parseFlowSections(body);
  if (sections.length === 0) {
    // Marker present but no sub-sections (older live format): show the lot
    // as the header.
    return { headerMarkdown: body, title: null, instructions: null, inputsMarkdown: null };
  }
  const pick = (kind: FlowSectionKind) =>
    sections.find((s) => s.kind === kind)?.content ?? null;
  const inputs = pick('inputs');
  return {
    headerMarkdown: pick('header'),
    title: null,
    instructions: pick('instructions'),
    inputsMarkdown: inputs && inputs !== '_no inputs_' ? inputs : null,
  };
}

function fromRawPrompt(raw: string): FlowStepContent {
  // Split system-prompt portion from the inputs block.
  const inputsAt = raw.indexOf(INPUTS_DELIMITER);
  const sysPart = inputsAt >= 0 ? raw.slice(0, inputsAt) : raw;

  // Instructions = the role prompt, with the boilerplate output contract
  // (and anything after it) trimmed off.
  const contractAt = sysPart.indexOf(OUTPUT_CONTRACT_HEADING);
  const instructions = (contractAt >= 0 ? sysPart.slice(0, contractAt) : sysPart).trim();

  // Title from the role prompt's opening line.
  const roleMatch = instructions.match(
    /You are the (.+?) step of a multi-stage automated flow/i,
  );
  const title = roleMatch ? `${roleMatch[1].toLowerCase()} step` : 'flow step';

  // Inputs block sits between INPUTS: and the trailing "Proceed…" line.
  let inputsMarkdown: string | null = null;
  if (inputsAt >= 0) {
    const afterInputs = raw.slice(inputsAt + INPUTS_DELIMITER.length);
    const proceedAt = afterInputs.indexOf(PROCEED_DELIMITER);
    const inputsBlock = (proceedAt >= 0 ? afterInputs.slice(0, proceedAt) : afterInputs).trim();
    inputsMarkdown = renderRawInputs(inputsBlock);
  }

  return {
    headerMarkdown: null,
    title,
    instructions: instructions || null,
    inputsMarkdown,
  };
}

const INPUT_BLOCK_RE =
  /<input name="([^"]+)"(?:\s+attached="([^"]+)"[^>]*)?>\n?([\s\S]*?)\n?<\/input>/g;

/// Turn the raw `<input name="…">…</input>` blocks back into the same
/// markdown the live display text uses (heading per input + fenced body).
function renderRawInputs(block: string): string | null {
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  INPUT_BLOCK_RE.lastIndex = 0;
  while ((m = INPUT_BLOCK_RE.exec(block)) !== null) {
    const [, name, attachedPath, body] = m;
    parts.push(`#### ${name}`);
    if (attachedPath) {
      parts.push(`_(attached file: ${attachedPath})_`);
    } else {
      parts.push(formatInputBodyForDisplay(name, body.trim()));
    }
  }
  if (parts.length === 0) {
    return block.trim() === '(no inputs provided)' ? null : block.trim() || null;
  }
  return parts.join('\n\n');
}

/// Renderer-side mirror of the main process's formatInputBodyForDisplay:
/// markdown inputs pass through; diffs/patches get a ```diff fence; the
/// user's own words pass through; everything else lands in a plain fence.
function formatInputBodyForDisplay(name: string, body: string): string {
  const lower = name.toLowerCase();
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    name === 'your request' ||
    name === 'user_prompt'
  ) {
    return body;
  }
  if (lower === 'diff' || lower.endsWith('.diff') || lower.endsWith('.patch')) {
    return '```diff\n' + body + '\n```';
  }
  return '```\n' + body + '\n```';
}
