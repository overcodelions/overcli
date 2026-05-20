// AI-assisted flow drafting. The user types a description of what they
// want (e.g. "fix a Jira ticket then open a PR"), and we ask their
// PREFERRED CLI — with the Flow YAML schema in its system prompt — to
// generate a draft. The result lands in the editor; the user refines from
// there.
//
// Backend selection mirrors the rest of the app: the user's preferred
// backend when it's healthy, otherwise the first healthy premium backend
// (see pickDrafterBackend). Claude takes a fast in-process path via the
// @anthropic-ai/claude-agent-sdk (no subprocess, tools fully off); every
// other CLI runs as a hidden one-shot through the RunnerManager, which
// already speaks all the backends. Auth uses whatever credentials that CLI
// relies on.

import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import type { AppSettings, Backend } from '../../shared/types';
import type { Flow } from '../../shared/flows/schema';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { FLOW_TEMPLATES } from '../../shared/flows/templates';
import {
  pickDrafterBackend,
  drafterModelFor,
  drafterModelHints,
} from '../../shared/flows/drafterBackend';
import { probeBackendHealth } from '../health';
import type { OneShotResult, RunnerManager } from '../runner';

export interface DraftDeps {
  settings: AppSettings;
  runner: RunnerManager;
}

/// Human-facing CLI name for error/status copy. Kept local so the drafter
/// (main process) doesn't reach into renderer-only helpers.
function backendLabel(backend: Backend): string {
  switch (backend) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'Copilot';
    case 'ollama':
      return 'Ollama';
    case 'claude':
    default:
      return 'Claude';
  }
}

/// System prompt fed to the drafting CLI. Carries the schema as YAML (more
/// compact than TypeScript types in tokens) plus one fully-worked example so
/// the model sees the exact shape we expect back. The CONVENTIONS section and
/// the closing note steer the generated flow's steps toward `backend` (the
/// CLI the user prefers) instead of always defaulting to Claude.
function systemPrompt(backend: Backend): string {
  const hints = drafterModelHints(backend);
  const label = backendLabel(backend);
  return [
    'You are a flow designer for overcli. A "flow" is a sequence of LLM steps that run autonomously,',
    'each step backed by its own model + tools, with artifact handoff. The user will describe what',
    'they want; you respond with ONLY a YAML body that conforms to the schema below — no prose, no',
    'code fences, no commentary. Start your response on the first line with `name:`.',
    '',
    'SCHEMA',
    '======',
    'Top-level keys:',
    '  name        — required, short human title',
    '  description — optional, 1–3 line summary',
    '  input       — always the literal string `user_prompt`',
    '  steps       — list of step objects',
    '',
    'Each step has:',
    '  id            — kebab-case identifier referenced by other steps',
    '  model         — { backend: claude|codex|gemini|copilot|ollama, model: "<id>" }',
    '  role          — planner | implementer | reviewer | test-writer | researcher | shipper | custom',
    '  inputs        — list of refs. May include "user_prompt" and outputs of EARLIER steps',
    '  tools         — list of tool ids. For claude/codex/gemini/copilot: Read, Write, Edit, Grep,',
    '                  Glob, Bash, WebFetch, Task. For ollama: read_file, list_dir, grep.',
    '  output        — artifact name this step produces (e.g. plan.md, diff, review.md, pr_url)',
    '  permission_mode — optional. acceptEdits | bypassPermissions | default | plan | auto',
    '  pause_before  — optional bool. When true, the run pauses BEFORE this step so the user can',
    '                  review prior artifacts. NEVER set on the first step.',
    '  rebound       — optional. { critic: {backend, model}, mode: review|collab, max_iters: N }',
    '  on_fail       — optional. { action: pause|goto|abort, target?: <stepId>, max_retries?: N }',
    '',
    'CONVENTIONS',
    '===========',
    `This user prefers the "${backend}" backend (${label}). Use it for EVERY step unless the user`,
    'explicitly asks for a different one. Pick the model per step by role:',
    `  - planning + review: { backend: ${backend}, model: ${hints.thinking} }`,
    `  - rebound critic / cheaper steps: { backend: ${backend}, model: ${hints.standard} }`,
    `  - implementers + test-writers: { backend: ${backend}, model: ${hints.fast} }`,
    'Always include at least one step that consumes "user_prompt".',
    'Default to permission_mode: bypassPermissions on any step that writes (so the flow can run',
    'unattended). pause_before: true is the right knob for human checkpoints — set it on shipper',
    'steps that push code, open PRs, or send messages.',
    '',
    'EXAMPLE',
    '=======',
    FLOW_TEMPLATES[0].yaml,
    '',
    `NOTE: the example above happens to use claude + ollama, but THIS user prefers ${label} —`,
    `use ${backend} models (as listed under CONVENTIONS) for the steps you generate, not claude.`,
    '',
    'Now produce a YAML for the user\'s described flow. Reply with YAML only.',
  ].join('\n');
}

/// Draft a flow from the user's description using their preferred CLI.
/// Returns the parsed Flow (validated) or a surfaced error the renderer can
/// show. Times out at 120s.
export async function draftFlowFromPrompt(
  args: { description: string },
  deps: DraftDeps,
): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }> {
  const desc = args.description.trim();
  if (!desc) return { ok: false, error: 'Description is empty.' };

  const backend = pickDrafterBackend({
    preferred: deps.settings.preferredBackend,
    isHealthy: (b) =>
      probeBackendHealth(b, deps.settings.backendPaths[b]).kind === 'ready',
    isEnabled: (b) => deps.settings.disabledBackends[b] !== true,
  });
  if (!backend) {
    return {
      ok: false,
      error:
        'No CLI is signed in to draft with. Set up Claude, Codex, Gemini, or Copilot in Settings first.',
    };
  }
  const model = drafterModelFor(backend);
  const label = backendLabel(backend);

  const text =
    backend === 'claude'
      ? await draftViaClaudeSdk(desc, model)
      : await draftViaRunner(deps.runner, backend, model, desc);
  if (!text.ok) return text;

  return finalizeDraft(text.text, label);
}

/// Fast in-process path for Claude: a pure-text generation with the
/// claude_code preset bypassed and tools fully disabled.
async function draftViaClaudeSdk(
  desc: string,
  model: string,
): Promise<OneShotResult> {
  let collected = '';
  try {
    const stream = query({
      prompt: desc,
      options: {
        // Pure custom system prompt — we don't want the claude_code preset
        // injecting its project-context bits into a pure text-generation
        // task. The schema + example carries everything the model needs.
        systemPrompt: systemPrompt('claude'),
        model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No tools — this is text generation only. We explicitly forbid
        // them rather than relying on the model not to ask.
        allowedTools: [],
      },
    });
    for await (const event of stream) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') collected += block.text;
        }
      }
      if (event.type === 'result') break;
    }
  } catch (err) {
    return {
      ok: false,
      error: `Claude SDK call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, text: collected };
}

/// Generic path for every non-Claude CLI: a hidden one-shot through the
/// RunnerManager. The system prompt is folded into the user prompt since
/// `oneShot` has no separate system-prompt channel (same approach the flow
/// runtime uses for step prompts).
async function draftViaRunner(
  runner: RunnerManager,
  backend: Backend,
  model: string,
  desc: string,
): Promise<OneShotResult> {
  const prompt = `${systemPrompt(backend)}\n\n---\n\nUSER REQUEST:\n${desc}\n\nReply with YAML only.`;
  return runner.oneShot({ backend, model, prompt, cwd: os.homedir() });
}

/// Parse + validate the raw CLI output into a Flow. Shared by every
/// backend path. `label` names the CLI in any error message.
function finalizeDraft(
  raw: string,
  label: string,
): { ok: true; flow: Flow } | { ok: false; error: string } {
  const yaml = stripCodeFences(raw.trim());
  if (!yaml) return { ok: false, error: `${label} returned no content.` };

  const parsed = parseFlowYaml({
    yaml,
    id: 'drafted-flow',
    source: 'user',
    filePath: '',
  });
  if (!parsed) return { ok: false, error: `${label} returned unparseable YAML.` };

  // Give it a unique id derived from the name so saving it later doesn't
  // collide with another flow named "drafted-flow".
  parsed.id = slugify(parsed.name) || 'drafted-flow';

  const v = validateFlow(parsed);
  if (!v.ok) {
    return {
      ok: false,
      error:
        `${label}'s draft failed validation: ` +
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    };
  }
  return { ok: true, flow: parsed };
}

/// Strip ```yaml … ``` fences if Claude wraps despite our instruction. We
/// also accept a plain ``` fence.
function stripCodeFences(text: string): string {
  const fenced = text.match(/^```(?:yaml|yml)?\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1].trim();
  return text;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
