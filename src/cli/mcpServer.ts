// `overcli mcp` — the saved flow library, offered to any MCP client over stdio.
//
// Everything else in this directory is driven by a person or a pipeline. This
// is driven by another agent: Claude Desktop or Claude Code lists the flows,
// starts one with a prompt, and comes back later to ask how it went. That is
// the whole surface — three tools, all read/list/run. Nothing here deletes,
// edits, approves or resumes, and nothing listens on a port.
//
// There is still no second runtime. `buildEngines` constructs the engines
// `overcli run` uses, and `run_flow` takes the same preflight → startRun path
// `runFlow` in run.ts takes. It deliberately does NOT use `buildDaemonEngines`:
// that one arms the scheduler, and connecting a chat client must not start
// firing the user's saved schedules underneath it.
//
// stdout belongs to JSON-RPC. One stray line there and the client drops the
// connection, so every diagnostic in this file goes through `err` (stderr).

import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadAllFlows } from '../main/flows/storage';
import { preflightRun } from '../main/flows/preflight';
import { Store, flushStoreSync } from '../main/store';
import type { Flow, FlowRun } from '../shared/flows/schema';
import { defaultCwd, type McpOptions } from './args';
import { buildEngines, ensureProject, type HeadlessEngines } from './engines';
import { EXIT, summariseRun, type RunSummary } from './run';

/// How much of a diff `get_run` hands back verbatim. The counts cover the
/// whole diff; the preview is only there so the caller can see the shape of
/// the change without a second round trip, and a model's context is not the
/// place for a 2 MB patch.
export const DIFF_PREVIEW_CHARS = 4000;

export interface McpServerContext {
  engines: HeadlessEngines;
  options: McpOptions;
  /// For `defaultCwd`. Injected so a test is not at the mercy of the runner's
  /// $GITHUB_WORKSPACE.
  env?: NodeJS.ProcessEnv;
  processCwd?: () => string;
}

export interface DiffSummary {
  /// The artifact name the runtime stored the cumulative diff under.
  artifact: string;
  producedByStepId: string;
  files: string[];
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
}

/// Count what a stored diff touched. This reads the text the runtime already
/// produced (`FlowRun.artifacts`, kind `diff` — the cumulative diff, see
/// schema.ts) and computes nothing git would; it is a tally, not a differ.
export function summariseDiffArtifacts(run: FlowRun): DiffSummary[] {
  const out: DiffSummary[] = [];
  for (const art of Object.values(run.artifacts ?? {})) {
    if (art.kind !== 'diff') continue;
    const files: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of art.body.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const m = / b\/(.+)$/.exec(line);
        if (m && !files.includes(m[1])) files.push(m[1]);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        additions += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions += 1;
      }
    }
    out.push({
      artifact: art.name,
      producedByStepId: art.producedByStepId,
      files,
      additions,
      deletions,
      preview: art.body.slice(0, DIFF_PREVIEW_CHARS),
      truncated: art.body.length > DIFF_PREVIEW_CHARS,
    });
  }
  return out;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/// A tool failure the model should read and act on — not a protocol error.
/// "Flow not found" is an answer, and an exception would hide it from the
/// caller behind a generic JSON-RPC failure.
function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/// Every registered project, so a flow saved inside a project's `.overcli/`
/// is listed exactly when `startRun` (which resolves through the same
/// projects) would find it.
function libraryFlows(extraProjectPath?: string): Flow[] {
  const projectPaths = Store.load().projects.map((p) => p.path);
  if (extraProjectPath && !projectPaths.includes(extraProjectPath)) projectPaths.push(extraProjectPath);
  return loadAllFlows({ projectPaths });
}

export function createMcpServer(ctx: McpServerContext): McpServer {
  const { engines, options } = ctx;
  const server = new McpServer({ name: 'overgo', version: '1' });

  server.registerTool(
    'list_flows',
    {
      description: 'List the flows saved in this overcli library. Returns id, name and description for each.',
      inputSchema: {},
    },
    async () =>
      json(
        libraryFlows().map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description ?? '',
        })),
      ),
  );

  server.registerTool(
    'run_flow',
    {
      description:
        'Start a saved flow and return its run id immediately, without waiting for it to finish. ' +
        'Poll get_run with the id to follow it.',
      inputSchema: {
        flowId: z.string().describe('A flow id from list_flows.'),
        input: z.string().optional().describe("The run's user_prompt."),
        cwd: z
          .string()
          .optional()
          .describe('Absolute path of the project to run in. Defaults to the one the server was started with.'),
      },
    },
    async ({ flowId, input, cwd }) => {
      const projectPath = path.resolve(
        cwd ?? options.cwd ?? defaultCwd(ctx.env ?? process.env, (ctx.processCwd ?? process.cwd)()),
      );
      const flow = libraryFlows(projectPath).find((f) => f.id === flowId);
      if (!flow) return failure(`No saved flow has id "${flowId}". Call list_flows for the ids that exist.`);

      // Preflight BEFORE registering the project, so a typo'd cwd is refused
      // rather than written into the store as a project that doesn't exist.
      const pre = await preflightRun({ flow, projectPath, settings: Store.load().settings });
      const blocking = pre.problems.filter((p) => p.severity === 'error');
      if (!pre.ok) {
        return failure(`Preflight failed: ${(blocking.length ? blocking : pre.problems).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
      }
      ensureProject(projectPath);

      // Same arguments `runFlow` passes (run.ts), for the same reasons: there
      // is no human here, so the run is unattended unless the operator chose
      // auto-approve, and only an allow-list pre-authorises anything.
      const started = await engines.flowRuntime.startRun({
        flowId: flow.id,
        projectPath,
        userPrompt: input ?? '',
        runIn: 'cwd',
        unattended: options.permissions !== 'auto-approve',
        unattendedAllowedTools: options.permissions === 'allow-list' ? options.allowTools : [],
      });
      if (!started.ok) return failure(`Could not start ${flow.id}: ${started.error}`);
      return json({ runId: started.runId, flowId: flow.id, projectPath });
    },
  );

  server.registerTool(
    'get_run',
    {
      description:
        "A run's current status (running, done, failed, paused:<reason>, aborted), each step's latest outcome, " +
        'and a summary of the code it changed.',
      inputSchema: {
        runId: z.string().describe('The id run_flow returned.'),
      },
    },
    async ({ runId }) => {
      const run = engines.flowRuntime.getRun(runId);
      if (!run) return failure(`No run has id "${runId}" in this state directory.`);
      const base: RunSummary = {
        ok: false,
        kind: 'flow',
        status: '',
        exitCode: EXIT.OK,
        projectPath: run.projectPath,
        steps: [],
        artifacts: [],
        permissionDecisions: [],
        warnings: [],
      };
      // `summariseRun` only reads `flow.id` from the flow; the snapshot is the
      // definition the run actually ran, which is the honest one to name.
      const flow = run.flowSnapshot ?? ({ id: run.flowId } as Flow);
      const summary = summariseRun({ run, flow, summaryBase: base, decisions: [], warnings: [], runId });
      return json({
        runId,
        flowId: run.flowId,
        status: summary.status,
        ok: summary.ok,
        error: summary.error,
        // A bare `paused:failure` tells the calling agent nothing it can act
        // on, so each step carries its latest attempt's own error message.
        steps: summary.steps.map((s) => {
          const last = run.attempts.filter((a) => a.stepId === s.id).at(-1);
          return last?.errorMessage ? { ...s, error: last.errorMessage } : s;
        }),
        artifacts: summary.artifacts.map((a) => a.name),
        headline: run.digest?.headline,
        costUSD: run.costUSD,
        projectPath: run.projectPath,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        diff: summariseDiffArtifacts(run),
      });
    },
  );

  return server;
}

export interface McpDeps {
  /// stderr in production. Never stdout — see the header.
  err: (line: string) => void;
}

/// Serve until the client goes away. A client ends the session by closing our
/// stdin (that is how Claude Desktop stops a server), so stdin's `end` is the
/// shutdown signal; SIGINT/SIGTERM are honoured too for someone running it by
/// hand.
export async function mcpCommand(options: McpOptions, deps: McpDeps): Promise<number> {
  const engines = buildEngines({
    stateDir: options.stateDir,
    policy: options.permissions,
    allowTools: options.allowTools,
    onPermission: (d) => deps.err(`permission ${d.approved ? 'allowed' : 'denied'}: ${d.toolName} — ${d.reason}`),
    onNotify: ({ title, body }) => deps.err(`${title}: ${body}`),
  });
  const server = createMcpServer({ engines, options });
  const transport = new StdioServerTransport();

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (why: string) => {
      if (finished) return;
      finished = true;
      deps.err(`overcli mcp: ${why} — stopping.`);
      void server.close().catch(() => {});
      engines.dispose();
      // Store writes are debounced (store.ts), and `main` ends in
      // `process.exit`, which would drop a pending one — e.g. the project a
      // `run_flow` just registered. The desktop app flushes on quit for the
      // same reason (index.ts).
      flushStoreSync();
      resolve(EXIT.OK);
    };
    process.stdin.once('end', () => finish('client closed stdin'));
    process.once('SIGINT', () => finish('SIGINT'));
    process.once('SIGTERM', () => finish('SIGTERM'));
    server
      .connect(transport)
      .then(() => {
        deps.err(
          `overcli mcp: serving ${libraryFlows().length} flow(s) over stdio; permissions: ${options.permissions}` +
            (options.stateDir ? `; state: ${options.stateDir}` : ''),
        );
      })
      .catch((e: unknown) => {
        deps.err(`overcli mcp: could not start: ${e instanceof Error ? e.message : String(e)}`);
        engines.dispose();
        finished = true;
        resolve(EXIT.RUN_FAILED);
      });
  });
}
