// Does a model id work on this server's model provider? Setup → Model ids
// asks before a worker's run finds out the hard way.
//
// Each id gets one tiny prompt through the Claude Code CLI, the way workers
// reach the model, so the answer covers the whole path: the environment,
// the credentials, the region and the id. The run carries no tools, no MCP
// servers, no settings and a one-line system prompt, so it costs well under
// a cent. The CLI's error is turned into a reason an admin can act on.

import { execFile } from 'node:child_process';
import os from 'node:os';
import type { ModelProviderKind } from './providerModels';

export type ModelIdVerdict =
  | 'ok'
  | 'needs-profile'
  | 'credentials'
  | 'not-enabled'
  | 'denied'
  | 'unknown-id'
  | 'timeout'
  | 'no-cli'
  | 'error';

export interface ModelIdResult {
  model: string;
  ok: boolean;
  verdict: ModelIdVerdict;
  /// What to do about it, in a sentence.
  message: string;
  /// The provider's own words, cut short.
  detail?: string;
  ms?: number;
}

/// Anthropic ids, Bedrock ids and inference profiles, ARNs and Vertex's
/// `@` versions. Passed to the CLI as one argument, never through a shell.
export const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

const PROMPT = 'Reply with ok.';

export function modelIdTestArgs(model: string): string[] {
  return [
    '-p', PROMPT,
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', PROMPT,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
}

const CREDENTIALS: Record<ModelProviderKind, string> = {
  bedrock: 'The server has no working AWS credentials. Set AWS_BEARER_TOKEN_BEDROCK, or give the server a role that can call Bedrock.',
  vertex: 'The server has no working Google credentials. Check its service account and ANTHROPIC_VERTEX_PROJECT_ID.',
  anthropic: 'The server has no working Anthropic credentials. Check ANTHROPIC_API_KEY.',
};

const DENIED: Record<ModelProviderKind, string> = {
  bedrock: 'The server’s AWS identity isn’t allowed to call this model. It needs bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream on it.',
  vertex: 'The server’s service account isn’t allowed to call this model. It needs the Vertex AI User role.',
  anthropic: 'This API key isn’t allowed to call this model.',
};

/// The reason for a failed call, from the CLI's message and the provider's
/// HTTP status. The most specific match wins: Bedrock reports several of
/// these as 403s or 400s with different words.
export function classifyModelError(text: string, provider: ModelProviderKind, status?: number): { verdict: ModelIdVerdict; message: string } {
  if (/on-demand throughput|retry your request with the id or arn of an inference profile/i.test(text))
    return { verdict: 'needs-profile', message: 'This model is only called through an inference profile. Put us., eu., apac. or global. in front of the id.' };
  if (/could not load credentials|unable to locate credentials|security token included in the request is (invalid|expired)|expiredtoken|unrecognizedclient|invalid (x-)?api[ -]key|authentication_error|invalid bearer token|could not load the default credentials/i.test(text))
    return { verdict: 'credentials', message: CREDENTIALS[provider] };
  if (/(don['’]t|do not) have access to the model|model access|not available in (this|your) region|is not enabled for|hasn['’]t been enabled/i.test(text))
    return {
      verdict: 'not-enabled',
      message: provider === 'bedrock' ? 'This account hasn’t turned on access to this model in this region. Turn it on under Bedrock → Model access.' : 'This model isn’t turned on for this project or region.',
    };
  if (/not authorized to perform|accessdenied|access denied|no identity-based policy|permission_denied|permission denied/i.test(text) || status === 403)
    return { verdict: 'denied', message: DENIED[provider] };
  if (/model identifier is invalid|issue with the selected model|unrecognized_model|not_found_error|model.{0,40}not found|invalid model/i.test(text) || status === 404)
    return {
      verdict: 'unknown-id',
      message:
        provider === 'bedrock'
          ? 'Bedrock doesn’t know this id, or this account can’t see it. Copy it from Bedrock → Inference profiles.'
          : 'The provider doesn’t know this id, or this account can’t see it.',
    };
  return { verdict: 'error', message: 'The model didn’t answer. The provider said why, below.' };
}

/// The CLI's `result` line, when it wrote one. It can print other lines
/// around it, so the last one that parses as a result wins.
function resultLine(stdout: string): { is_error?: boolean; result?: string; api_error_status?: number; duration_ms?: number } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed.type === 'result') return parsed;
    } catch {
      // not this line
    }
  }
  return null;
}

const cut = (s: string): string | undefined => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 400 ? `${t.slice(0, 400)}…` : t) : undefined;
};

/// One test's outcome from what the CLI printed.
export function readModelIdTest(model: string, provider: ModelProviderKind, out: { stdout: string; stderr: string; timedOut: boolean; error?: string; ms: number }): ModelIdResult {
  if (out.timedOut) return { model, ok: false, verdict: 'timeout', message: 'No answer within the time allowed. The provider may be slow or unreachable from this server.', ms: out.ms };
  const line = resultLine(out.stdout);
  if (line && line.is_error === false) return { model, ok: true, verdict: 'ok', message: 'Works.', ms: line.duration_ms ?? out.ms };
  const said = [line?.result ?? '', out.stderr, line ? '' : out.stdout, out.error ?? ''].filter(Boolean).join('\n');
  const { verdict, message } = classifyModelError(said, provider, line?.api_error_status);
  const detail = cut(said);
  return { model, ok: false, verdict, message, ...(detail ? { detail } : {}), ms: out.ms };
}

export type ModelIdRunner = (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; timedOut: boolean; error?: string }>;

const runCli: ModelIdRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: !!e?.killed,
        // A non-zero exit still printed its reason; only a failure to start
        // has nothing else to say.
        ...(e && !e.killed && typeof e.code === 'string' ? { error: e.message } : {}),
      });
    });
  });

export interface ModelIdTestDeps {
  /// The claude CLI, or null when the server has none.
  bin: string | null;
  env: NodeJS.ProcessEnv;
  provider: ModelProviderKind;
  run?: ModelIdRunner;
  timeoutMs?: number;
  /// Tests at once. A handful, so "Test all" is quick but doesn't burst.
  concurrency?: number;
}

export async function testModelIds(models: string[], deps: ModelIdTestDeps): Promise<ModelIdResult[]> {
  const unique = [...new Set(models)];
  const run = deps.run ?? runCli;
  const one = async (model: string): Promise<ModelIdResult> => {
    if (!MODEL_ID_SHAPE.test(model)) return { model, ok: false, verdict: 'unknown-id', message: 'That doesn’t look like a model id.' };
    if (!deps.bin) return { model, ok: false, verdict: 'no-cli', message: 'The Claude Code CLI isn’t installed on this server.' };
    const started = Date.now();
    // Somewhere with no project of its own, so no CLAUDE.md or settings ride along.
    const out = await run(deps.bin, modelIdTestArgs(model), { env: deps.env, cwd: os.tmpdir(), timeoutMs: deps.timeoutMs ?? 60_000 });
    return readModelIdTest(model, deps.provider, { ...out, ms: Date.now() - started });
  };
  const results: ModelIdResult[] = new Array(unique.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(deps.concurrency ?? 3, unique.length) }, async () => {
    while (next < unique.length) {
      const i = next++;
      results[i] = await one(unique[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}
