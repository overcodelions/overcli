// The long tail: asking a model why a service will not start.
//
// The rules in `triage.ts` answer the cases worth answering deterministically
// — they are free, offline, checkable and covered by tests, and they run
// first. This is what happens when none of them fires, and it is deliberately
// a SECOND step rather than the first one: a plausible wrong answer given
// confidently costs more than saying nothing, so the model only speaks where
// there was going to be silence, and what it says is labelled a guess.
//
// The prompt is built here, and built PURELY, because everything difficult
// about it is a judgement call about what to include:
//
//   — the tail of the output, not all of it: the useful line is near the end,
//     and a 200k-line Gradle log buys nothing but latency;
//   — the command, the environment and the options as they were ACTUALLY
//     resolved, because the bug is usually in the difference between those
//     and what the user believes they are;
//   — the findings the rules already produced, so the model does not spend
//     its answer restating something the pane said above it;
//   — and nothing secret. Options and injected variables are where passwords
//     live in this app, and a prompt leaves the machine.

import { redactSecrets } from '../secretScrub';
import type { ServiceFinding, ServiceSpec } from './types';

export interface AskContext {
  spec: ServiceSpec;
  /// Output as the pane has it, oldest first.
  lines: readonly string[];
  /// Environment handed to the process, after substitution.
  env: Record<string, string>;
  /// Startup options as resolved, `key` and `value` as they will be passed.
  options: readonly { key: string; value?: string }[];
  binding?: { ref: string; path: string };
  /// What the deterministic rules already said, if anything.
  findings: readonly ServiceFinding[];
  /// Values known to be credentials — machine values, mostly — so they can be
  /// scrubbed by value as well as by pattern.
  secrets?: readonly string[];
}

/// How much of the output to send. Enough to include a stack trace and the
/// lines that led into it; not so much that a Gradle build log dominates.
const TAIL_LINES = 120;

/// One question, with everything needed to answer it and nothing else.
export function buildFixPrompt(ctx: AskContext): string {
  const secrets = [...(ctx.secrets ?? [])];
  const scrub = (text: string): string => redactSecrets(text, secrets).text;

  const tail = ctx.lines.slice(-TAIL_LINES).join('\n').trim();
  const env = Object.entries(ctx.env)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const options = ctx.options.map((o) => (o.value === undefined ? o.key : `${o.key}=${o.value}`));

  const parts: string[] = [
    'A local service failed to start. Work out why, and say how to fix it.',
    '',
    `Service: ${ctx.spec.name} (${ctx.spec.runner})`,
    `Command: ${ctx.spec.command.join(' ')}`,
  ];
  if (ctx.binding) {
    parts.push(`Checkout: ${ctx.binding.path} on ${ctx.binding.ref}`);
  }
  if (ctx.spec.subpath) parts.push(`Runs from: ${ctx.spec.subpath} inside the checkout`);
  if (ctx.spec.port !== undefined) parts.push(`Expected port: ${ctx.spec.port}`);

  // What the user's own setup runs. A detected `npm run start` knows nothing
  // of the `nvm use` and the flags the Tiltfile wraps it in — and those are
  // usually the answer.
  const from = ctx.spec.importedFrom;
  if (from) {
    parts.push('', `It was imported from the ${from.source} in ${from.project}.`);
    if (from.excerpt) {
      parts.push('This is what defines it there — compare it with the command above:', '```', from.excerpt, '```');
    }
  }

  parts.push(
    '',
    env.length > 0
      ? `Environment set for it:\n${env.map((l) => `  ${l}`).join('\n')}`
      : 'No environment was set for it.',
    '',
    options.length > 0
      ? `Startup options (${options.length}):\n${options.map((l) => `  ${l}`).join('\n')}`
      : 'It has no startup options at all.',
  );

  if (ctx.findings.length > 0) {
    parts.push(
      '',
      'Already reported to the user — do not repeat these, build on them:',
      ...ctx.findings.map((f) => `  - ${f.title}`),
    );
  }

  parts.push(
    '',
    `Its last ${Math.min(TAIL_LINES, ctx.lines.length)} lines of output:`,
    '```',
    tail === '' ? '(it printed nothing)' : tail,
    '```',
    '',
    // The instructions matter as much as the context. Left open, a model
    // answers a failed start with six numbered possibilities, which is the
    // same as no answer — the user already has a list of possibilities.
    'You may read files in the checkout to check your answer. Then reply with at most six lines of plain text:',
    'one sentence naming the single most likely cause, then the exact change that would fix it —',
    'a command to run, a startup option to add with its value, or a file to edit with what to put in it.',
    'If the output does not contain enough to tell, say exactly that and name the one thing to look at next.',
    'No preamble, no numbered lists of alternatives, no markdown headings.',
    // Machine-readable, so the pane can offer to apply it. Only for a start
    // command: an option or a file edit is not something one line can carry.
    'If the fix is a different start command, end with one extra line: COMMAND: <the complete command line>.',
    'It is run from the folder above, without a shell unless it uses && or |, in which case through sh -c.',
    'Leave that line out for any other kind of fix.',
  );

  return scrub(parts.join('\n'));
}

/// The `COMMAND:` line the prompt asks for, taken out of the answer. The last
/// one wins — a model that changes its mind mid-answer means the later one.
export function splitSuggestedCommand(text: string): { text: string; command?: string } {
  let command: string | undefined;
  const rest = text.split('\n').filter((line) => {
    const match = /^\s*`?COMMAND:\s*(.+?)\s*$/.exec(line);
    if (!match) return true;
    command = match[1].replace(/^`+|`+$/g, '').trim() || undefined;
    return false;
  });
  return { text: rest.join('\n'), command };
}

/// Trim a model's answer down to what the pane can show. Models add a
/// greeting and a sign-off however firmly you ask them not to.
export function tidySuggestion(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .filter((l) => !/^#{1,6}\s/.test(l))
    .filter((l) => !/^```/.test(l));
  return lines.slice(0, 8).join('\n').trim();
}
