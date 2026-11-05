// The test-systems tool's process: `node testSystemsServer.js --systems <file>`.
//
// Installed as a command tool (testSystems.ts), so the relay starts it for
// each run with its sealed env (the apps' test credentials), told the worker
// (OVERCLI_WORKER, overdbBinding.ts). It serves MCP on stdio and starts a
// Playwright MCP server behind it; testSystemsSession.ts does the work.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TEST_SYSTEMS_VERSION, type TestSystem, type TestSystemsFile } from '../../shared/testSystems';
import { NO_BROWSER, TestSystemsSession, browserMissing, resultValue, type BrowserChild, type ToolResult } from './testSystemsSession';
import { HEALTH_PATHS, discoverScript, planFromScan, type Discovered, type ScreenScan } from './testSystemsDiscover';

/// The Playwright MCP the tool drives, pinned: the tools it passes through,
/// and the ones it keeps for signing in, are by name. $OVERCLI_PLAYWRIGHT_MCP
/// names another package spec.
export const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.84';

/// The Playwright that Playwright MCP version pins: its Chromium is the one
/// the Docker image installs (deploy/Dockerfile PLAYWRIGHT_VERSION). Change
/// the two together.
export const PLAYWRIGHT_FOR_MCP = '1.65.0-alpha-2026-10-30';

/// How Playwright MCP starts: headless Chromium (Playwright's own, not Google
/// Chrome, which a server seldom has), an in-memory profile per run, with
/// the storage tools (for loading a session) and the test assertions on.
/// Chromium's sandbox needs privileges a container's user lacks on Linux.
export function playwrightArgs(outputDir: string, platform: NodeJS.Platform = process.platform): string[] {
  return [
    '-y',
    process.env.OVERCLI_PLAYWRIGHT_MCP?.trim() || PLAYWRIGHT_MCP,
    '--headless',
    '--browser',
    'chromium',
    ...(platform === 'linux' ? ['--no-sandbox'] : []),
    '--isolated',
    '--caps=storage,testing',
    '--output-dir',
    outputDir,
  ];
}

/// Start Playwright MCP, as `playwrightArgs` says.
export async function startPlaywright(outputDir: string): Promise<BrowserChild> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('OVERCLI_TS_')));
  const transport = new StdioClientTransport({
    command: 'npx',
    args: playwrightArgs(outputDir),
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'overcli-test-systems', version: '1' });
  await client.connect(transport);
  return {
    listTools: async () => (await client.listTools()).tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema as Record<string, unknown> })),
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}

export function readSystemsFile(file: string): TestSystem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TestSystemsFile>;
    return raw.version === TEST_SYSTEMS_VERSION && Array.isArray(raw.systems) ? raw.systems : [];
  } catch {
    return [];
  }
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-test-systems-'));
}

/// Open one app as a worker would, for Setup → Apps to test's Test button:
/// ready, signed in, its first page reached. What a worker would be told.
export async function checkSystem(system: TestSystem, environment: string | undefined, secrets: Record<string, string>): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const dir = scratch();
  const session = new TestSystemsSession({
    systems: () => [system],
    secret: (name) => secrets[name],
    startBrowser: () => startPlaywright(dir),
    tempDir: () => dir,
  });
  try {
    const res = await session.call('open_system', { system: system.id, ...(environment ? { environment } : {}) });
    const said = res.content.map((c) => c.text ?? '').filter(Boolean);
    return res.isError ? { ok: false, error: said.join(' ').slice(0, 600) } : { ok: true, detail: (said[0] ?? '').split('\n')[0] };
  } finally {
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// The first usual health check path that answers 2xx, if any.
export async function findHealth(origin: string, doFetch: typeof fetch = fetch): Promise<string | undefined> {
  for (const at of HEALTH_PATHS) {
    try {
      const res = await doFetch(`${origin}${at}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (res.status >= 200 && res.status < 300) return at;
    } catch {
      // Not there, or not answering: the next.
    }
  }
  return undefined;
}

/// Setup → Apps to test's Discover: open `address`, read its login form.
/// `username` only moves a two-screen login on to its password screen.
export async function discoverSystem(address: string, username?: string): Promise<{ ok: true; found: Discovered } | { ok: false; error: string }> {
  let start: URL;
  try {
    start = new URL(address);
  } catch {
    return { ok: false, error: 'Give the full address, like https://staging.billing.acme.dev.' };
  }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') return { ok: false, error: 'The address should start with https://.' };
  const dir = scratch();
  let child: BrowserChild | null = null;
  try {
    const health = findHealth(start.origin);
    child = await startPlaywright(dir);
    let res = await child.callTool('browser_run_code_unsafe', { code: discoverScript(start.href, username?.trim() || 'qa@example.com') });
    const said = res.content.map((c) => c.text ?? '').join(' ');
    if (res.isError && browserMissing(said)) {
      await child.callTool('browser_install', {}).catch(() => undefined);
      res = await child.callTool('browser_run_code_unsafe', { code: discoverScript(start.href, username?.trim() || 'qa@example.com') });
      if (res.isError && browserMissing(res.content.map((c) => c.text ?? '').join(' '))) return { ok: false, error: NO_BROWSER };
    }
    if (res.isError) return { ok: false, error: `Couldn’t open ${start.href}: ${res.content.map((c) => c.text ?? '').join(' ').split('```')[0].slice(0, 300)}` };
    const raw = resultValue(res);
    if (!raw) return { ok: false, error: 'The page opened but couldn’t be read.' };
    const scans = JSON.parse(raw) as { first: ScreenScan; second: ScreenScan | null };
    return { ok: true, found: planFromScan(start.href, scans, await health) };
  } catch (err) {
    return { ok: false, error: `Couldn’t open ${start.href}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400) };
  } finally {
    if (child) await child.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--systems');
  const file = at >= 0 ? process.argv[at + 1] : '';
  if (!file) {
    process.stderr.write('usage: testSystemsServer --systems <file>\n');
    process.exit(2);
  }
  const dir = scratch();
  const session = new TestSystemsSession({
    systems: () => readSystemsFile(file),
    secret: (name) => process.env[name],
    ...(process.env.OVERCLI_WORKER ? { worker: process.env.OVERCLI_WORKER } : {}),
    ...(process.env.OVERCLI_WORKER_FORMER ? { formerNames: process.env.OVERCLI_WORKER_FORMER.split('\n').filter(Boolean) } : {}),
    ...(process.env.OVERCLI_RUN_FILES ? { filesDir: process.env.OVERCLI_RUN_FILES } : {}),
    startBrowser: () => startPlaywright(dir),
    tempDir: () => dir,
  });
  const server = new Server({ name: 'test-systems', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await session.listTools() }) as never);
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await session.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)) as never);
  const stop = () => {
    void session.close().finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('close', stop);
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`test-systems: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
