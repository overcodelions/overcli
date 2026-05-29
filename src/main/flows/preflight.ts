// Pre-run validation. Static schema validation already runs at save time
// (src/shared/flows/validation.ts), but a flow can pass that and still fail
// at runtime — most commonly because the user picked an Ollama model they
// never pulled, or a premium backend the app doesn't have credentials for.
// This module does the live checks RIGHT BEFORE startRun, so the user gets
// a clear, listed error before any model gets spun up.

import fs from 'node:fs';

import type { AppSettings, Backend, BackendHealth } from '../../shared/types';
import { resolveStepModel, type Flow, type FlowModelRef } from '../../shared/flows/schema';
import { probeBackendHealth } from '../health';
import { detectOllama } from '../ollama';

export interface PreflightProblem {
  /// Severity. `error` blocks the run; `warning` is surfaced but allows
  /// the run to start. v1 only emits errors, but the renderer can treat
  /// them differently if we add warnings later.
  severity: 'error';
  /// Where the problem comes from — `flow`, `project`, or `steps[N].field`.
  /// Renderer can highlight the offending step / field in the editor.
  path: string;
  message: string;
  /// Short hint the renderer can render as a "Fix" link (e.g. opens the
  /// Ollama pane to install the missing model).
  hint?: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
}

/// Catalog of premium-model ids the backends accept. Same list the
/// WelcomePane uses to populate model pickers. Kept here so changes to
/// the picker propagate to validation automatically.
const PREMIUM_MODELS: Record<Exclude<Backend, 'ollama'>, string[]> = {
  claude: ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  copilot: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'gpt-5.5'],
};


export interface PreflightInput {
  flow: Flow;
  projectPath: string;
  settings: AppSettings;
}

/// Live preflight. Synchronous health/model probes can take a beat
/// (subprocess execs); wrap in async so callers can await without
/// blocking the event loop on the renderer thread.
export async function preflightRun(input: PreflightInput): Promise<PreflightResult> {
  const problems: PreflightProblem[] = [];
  const { flow, projectPath, settings } = input;

  // 1. Project path must exist + be a directory.
  if (!projectPath?.trim()) {
    problems.push({
      severity: 'error',
      path: 'project',
      message: 'No project or workspace selected to run in.',
    });
  } else {
    try {
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) {
        problems.push({
          severity: 'error',
          path: 'project',
          message: `${projectPath} is not a directory.`,
        });
      }
    } catch {
      problems.push({
        severity: 'error',
        path: 'project',
        message: `${projectPath} does not exist on disk.`,
      });
    }
  }

  // 2. Collect every backend + model referenced by the flow. Probe each
  // backend once even when many steps reference it — saves redundant
  // health checks.
  const backendsToProbe = new Set<Backend>();
  const ollamaModelsRequired = new Set<string>();
  for (const step of flow.steps) {
    const stepModel = resolveStepModel(flow, step);
    backendsToProbe.add(stepModel.backend);
    if (stepModel.backend === 'ollama') ollamaModelsRequired.add(stepModel.model);
    if (step.rebound) {
      backendsToProbe.add(step.rebound.critic.backend);
      if (step.rebound.critic.backend === 'ollama') {
        ollamaModelsRequired.add(step.rebound.critic.model);
      }
    }
  }

  // 3. Probe each backend's health. Note we don't gate on `kind` ===
  // 'ready' alone — some backends report 'unknown' before first use and
  // still work. We DO gate on 'unauthenticated' / 'missing' / 'error',
  // which mean the user must take action before any step will succeed.
  const backendHealth = new Map<Backend, BackendHealth>();
  await Promise.all(
    Array.from(backendsToProbe).map(async (b) => {
      try {
        const health = await probeBackendHealth(b, settings.backendPaths[b]);
        backendHealth.set(b, health);
      } catch (err) {
        backendHealth.set(b, {
          kind: 'error',
          message: `Health probe threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  // 4. For each step + critic, check backend health + model availability.
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    checkModelRef({
      ref: resolveStepModel(flow, step),
      path: `steps[${i}].model`,
      role: 'step',
      backendHealth,
      problems,
    });
    if (step.rebound) {
      checkModelRef({
        ref: step.rebound.critic,
        path: `steps[${i}].rebound.critic`,
        role: 'critic',
        backendHealth,
        problems,
      });
    }
    if (step.tools.length === 0 && step.role !== 'researcher' && step.role !== 'custom') {
      // Researchers can do text-only outputs; everyone else without
      // tools is suspicious but not fatal. Surface as a warning-flavored
      // error so the user knows they may have forgotten to enable them.
      problems.push({
        severity: 'error',
        path: `steps[${i}].tools`,
        message: `Step "${step.id}" has no tools selected — it can't read or modify anything.`,
        hint: 'Open the step and check at least one Allowed action.',
      });
    }
  }

  // 5. If any Ollama models are required, ask the daemon whether they're
  // actually pulled. Cheaper to do this once than probe per model.
  if (ollamaModelsRequired.size > 0) {
    try {
      const report = await detectOllama();
      if (!report.installed) {
        problems.push({
          severity: 'error',
          path: 'flow',
          message: 'Ollama is not installed — flows that reference local models can\'t run.',
          hint: 'Install via Local → Ollama.',
        });
      } else if (!report.running) {
        problems.push({
          severity: 'error',
          path: 'flow',
          message: 'Ollama is installed but not running.',
          hint: 'Start the Ollama server from Local → Ollama.',
        });
      } else {
        const pulled = new Set(report.models.map((m) => m.name));
        for (const required of ollamaModelsRequired) {
          if (!required.trim()) continue;
          if (!pulled.has(required)) {
            problems.push({
              severity: 'error',
              path: 'flow',
              message: `Local model "${required}" is not pulled.`,
              hint: `Pull it via Local → Ollama, or pick a different model.`,
            });
          }
        }
      }
    } catch (err) {
      problems.push({
        severity: 'error',
        path: 'flow',
        message: `Failed to probe Ollama: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

function checkModelRef(args: {
  ref: FlowModelRef;
  path: string;
  role: 'step' | 'critic';
  backendHealth: Map<Backend, BackendHealth>;
  problems: PreflightProblem[];
}) {
  const { ref, path, role, backendHealth, problems } = args;
  if (!ref.model?.trim()) {
    problems.push({
      severity: 'error',
      path,
      message: `${role === 'critic' ? 'Critic' : 'Step'} model is empty.`,
    });
    return;
  }
  const health = backendHealth.get(ref.backend);
  if (health && (health.kind === 'unauthenticated' || health.kind === 'missing' || health.kind === 'error')) {
    problems.push({
      severity: 'error',
      path,
      message:
        `Backend "${ref.backend}" is not ready: ${health.kind}${
          health.message ? ' — ' + health.message : ''
        }.`,
      hint:
        health.kind === 'missing'
          ? `Install the ${ref.backend} CLI.`
          : health.kind === 'unauthenticated'
            ? `Log in to ${ref.backend}.`
            : undefined,
    });
  }
  if (ref.backend !== 'ollama') {
    const known = PREMIUM_MODELS[ref.backend];
    if (known && !known.includes(ref.model)) {
      // Unknown model isn't necessarily wrong — the user might be on a
      // newer model than the static list — but we flag it so misspellings
      // surface here instead of failing the run with a cryptic CLI error.
      problems.push({
        severity: 'error',
        path,
        message: `Model "${ref.model}" isn't in the known list for backend "${ref.backend}".`,
        hint: 'Double-check the model id — typos here will fail the run with a CLI error.',
      });
    }
  }
}

/// Friendly multi-line summary of preflight problems for renderer banners.
export function formatPreflight(result: PreflightResult): string {
  if (result.ok) return 'Preflight ok.';
  return result.problems
    .map((p) => `• ${p.message}${p.hint ? ` (${p.hint})` : ''}`)
    .join('\n');
}
