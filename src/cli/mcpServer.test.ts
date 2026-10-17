// `overcli mcp`, driven the way a real MCP client drives it: the SDK's own
// `Client`, over the SDK's in-memory transport, against the server the CLI
// builds — on real engines, a real state dir, a real git project and a real
// flow run. The one thing that is not real is the model: `claude` is a small
// script that speaks just enough stream-json to finish a turn, and edits a
// file on the way so the run has an actual diff for `get_run` to report.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { parseArgs } from './args';
import { buildEngines, type HeadlessEngines } from './engines';
import { createMcpServer, summariseDiffArtifacts } from './mcpServer';
import { saveFlow } from '../main/flows/storage';
import { Store } from '../main/store';
import type { Flow, FlowRun } from '../shared/flows/schema';

const FAKE_CLAUDE = `#!/usr/bin/env node
// Stand-in for \`claude -p --input-format stream-json --output-format stream-json\`.
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const fs = require('fs');
const sid = 'fake-session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    fs.writeFileSync('hello.txt', 'hello from the fake model\\n');
    // The runtime wants the declared output block; for a diff-kind output it
    // then swaps the body for the real \`git diff\` of the working tree.
    const text = 'Wrote hello.txt.\\n<output name="diff">hello.txt</output>';
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-4-6', cwd: process.cwd(), tools: [] });
    out({ type: 'assistant', session_id: sid, message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: text,
      total_cost_usd: 0, num_turns: 1, duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function fixtureFlow(): Flow {
  return {
    id: 'mcp-fixture',
    name: 'MCP fixture',
    description: 'One step that writes hello.txt.',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-4-6' }],
    steps: [{ id: 'build', participantId: 'primary', role: 'implementer', inputs: ['user_prompt'], tools: [], output: 'diff' }],
    source: 'user',
    filePath: '',
  };
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0].text;
}

const dirs: string[] = [];
const savedFakeHealth = process.env.OVERCLI_FAKE_HEALTH;
let engines: HeadlessEngines;
let client: Client;
let project: string;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-mcp-'));
  dirs.push(root);
  const stateDir = path.join(root, 'state');
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: project });

  const fakeClaude = path.join(root, 'claude');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  // Health is faked so preflight does not try `claude auth status` on a
  // script; the binary itself is real and is what the runner spawns.
  process.env.OVERCLI_FAKE_HEALTH = 'claude:ready';

  engines = buildEngines({ stateDir, policy: 'deny', allowTools: [] });
  // The Seatbelt write jail is off for the same reason health is faked: it
  // is not what this file tests, and `sandbox-exec` refuses to nest, so under
  // any already-sandboxed test runner the step would die with status 71
  // before the fake model ever spoke.
  Store.saveSettings({ ...Store.load().settings, backendPaths: { claude: fakeClaude }, sandboxFlowWrites: false });
  const saved = saveFlow({ flow: fixtureFlow(), target: 'user' });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });

  const server = createMcpServer({ engines, options: { permissions: 'deny', allowTools: [], cwd: project } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'overcli-mcp-test', version: '0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close();
  engines?.dispose();
  if (savedFakeHealth === undefined) delete process.env.OVERCLI_FAKE_HEALTH;
  else process.env.OVERCLI_FAKE_HEALTH = savedFakeHealth;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('overcli mcp — over a real MCP client', () => {
  it('offers exactly the three tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_run', 'list_flows', 'run_flow']);
  });

  it('list_flows returns the saved flow, id/name/description only', async () => {
    const flows = JSON.parse(text(await client.callTool({ name: 'list_flows', arguments: {} })));
    expect(flows).toContainEqual({ id: 'mcp-fixture', name: 'MCP fixture', description: 'One step that writes hello.txt.' });
    for (const f of flows) expect(Object.keys(f).sort()).toEqual(['description', 'id', 'name']);
  });

  it('run_flow refuses an unknown flow as a tool error, not a protocol error', async () => {
    const res = await client.callTool({ name: 'run_flow', arguments: { flowId: 'nope', input: 'x' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No saved flow has id "nope"');
  });

  it('get_run refuses an unknown run id', async () => {
    const res = await client.callTool({ name: 'get_run', arguments: { runId: 'not-a-run' } });
    expect(res.isError).toBe(true);
  });

  it('run_flow starts a real run and returns at once; get_run follows it to done with its diff', async () => {
    const started = await client.callTool({ name: 'run_flow', arguments: { flowId: 'mcp-fixture', input: 'say hello' } });
    expect(started.isError).toBeFalsy();
    const { runId, projectPath } = JSON.parse(text(started));
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(projectPath).toBe(project);
    // A real run the runtime knows about — not an id minted by the tool.
    expect(engines.flowRuntime.getRun(runId)).not.toBeNull();

    // Returned before finishing: whatever the first status is, it comes from
    // the runtime, and it is the same thing the runtime says right now.
    const first = JSON.parse(text(await client.callTool({ name: 'get_run', arguments: { runId } })));
    expect(first.runId).toBe(runId);
    expect(typeof first.status).toBe('string');

    const seen = new Set<string>([first.status]);
    let last = first;
    const deadline = Date.now() + 20_000;
    while (!['done', 'failed', 'aborted'].includes(last.status) && !last.status.startsWith('paused') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      last = JSON.parse(text(await client.callTool({ name: 'get_run', arguments: { runId } })));
      seen.add(last.status);
    }

    const run = engines.flowRuntime.getRun(runId)!;
    expect(last.status, `statuses seen: ${[...seen].join(' → ')}; state ${JSON.stringify(run.state)}; attempts ${JSON.stringify(run.attempts)}`).toBe('done');
    expect(last.ok).toBe(true);
    expect(last.steps).toEqual([{ id: 'build', status: 'success' }]);
    expect(last.diff).toHaveLength(1);
    expect(last.diff[0].files).toContain('hello.txt');
    expect(last.diff[0].additions).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(project, 'hello.txt'), 'utf-8')).toContain('fake model');
  }, 30_000);
});

describe('summariseDiffArtifacts', () => {
  it('tallies files and lines from stored diff artifacts and ignores everything else', () => {
    const body = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      '+more',
      'diff --git a/b.md b/b.md',
      '+++ b/b.md',
      '+x',
    ].join('\n');
    const run = {
      artifacts: {
        diff: { name: 'diff', kind: 'diff', body, producedByStepId: 's', producedAt: 1 },
        'plan.md': { name: 'plan.md', kind: 'markdown', body: '+ not a diff', producedByStepId: 's', producedAt: 1 },
      },
    } as unknown as FlowRun;
    const [d, ...rest] = summariseDiffArtifacts(run);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ artifact: 'diff', files: ['a.ts', 'b.md'], additions: 3, deletions: 1, truncated: false });
  });
});

describe('parseArgs — mcp', () => {
  it('is accepted as a command, with serve’s defaults', () => {
    const parsed = parseArgs(['mcp']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.command).toBe('mcp');
    expect(parsed.args.mcp).toEqual({ permissions: 'deny', allowTools: [] });
    expect(parsed.args.warnings).toEqual([]);
    expect(parsed.args.run).toBeUndefined();
    expect(parsed.args.serve).toBeUndefined();
  });

  it('takes no file arguments', () => {
    const parsed = parseArgs(['mcp', 'flow.yaml']);
    expect(parsed).toEqual({ ok: false, error: 'overcli mcp takes no file arguments (got "flow.yaml").' });
  });

  it('accepts --state-dir, --cwd, --permissions and --allow-tool, in both flag spellings', () => {
    const parsed = parseArgs([
      'mcp',
      '--state-dir',
      '/tmp/state',
      '--cwd=/repo',
      '--permissions=allow-list',
      '--allow-tool',
      'Read,Grep',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.mcp).toEqual({
      stateDir: '/tmp/state',
      cwd: '/repo',
      permissions: 'allow-list',
      allowTools: ['Read', 'Grep'],
    });
  });

  it('refuses run-only options by name', () => {
    const parsed = parseArgs(['mcp', '--json']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('--json is a "run" option; overcli mcp takes --state-dir, --permissions, --allow-tool, --cwd.');
  });

  it('rejects a bad permission policy and a missing value', () => {
    expect(parseArgs(['mcp', '--permissions', 'yolo']).ok).toBe(false);
    expect(parseArgs(['mcp', '--state-dir'])).toEqual({ ok: false, error: '--state-dir needs a value.' });
  });

  it('is named in the unknown-command hint', () => {
    const parsed = parseArgs(['nope']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('overcli mcp');
  });
});
