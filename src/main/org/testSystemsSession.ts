// The test-systems tool's working part: a signed-in browser for a worker to
// QA an app with, where the worker never holds the credentials.
//
// The tool stands between the worker and a Playwright MCP server it starts
// itself. The worker gets three tools of its own (list the apps, open one on
// an environment, sign in again) and the ordinary browsing tools passed
// through. Everything that could read a session back out (cookies, storage,
// running code in the page, network details) stays with this side: it's how
// the server signs in, so the model can't. Signing in happens here, with the
// credentials from this process's env:
//
//   ready     an environment's health check is polled until it answers, so a
//             feature environment still building isn't mistaken for a bug
//   form      Playwright code fills the login page's fields and submits,
//             with an authenticator code when the app asks for one
//   endpoint  a test-only login endpoint is POSTed, and the session it sets
//             is loaded into the browser
//   again     a page that lands back on the sign-in page (the session ran
//             out) is signed in again here, and the page reopened, so an
//             unattended run carries on
//
// Credentials only ever go to an address `resolveEnvironment` allows.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  credentialEnv,
  extraEnv,
  mayOpen,
  resolveEnvironment,
  signedOutPath,
  type TestSystem,
} from '../../shared/testSystems';
import { totp } from './totp';

export interface ToolContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/// The Playwright MCP server behind this one.
export interface BrowserChild {
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface SessionDeps {
  /// Read each time, so a change on Setup → Apps to test applies to the next open.
  systems(): TestSystem[];
  /// A credential from this process's env.
  secret(name: string): string | undefined;
  /// The worker this run is for (OVERCLI_WORKER), for each app's who-may-open.
  worker?: string;
  /// Names it went by before (OVERCLI_WORKER_FORMER): an app that names one still opens.
  formerNames?: string[];
  startBrowser(): Promise<BrowserChild>;
  /// Where a session file lives for the moment it takes to load it.
  tempDir(): string;
  fetch?: typeof fetch;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /// The run's evidence folder (OVERCLI_RUN_FILES): screenshots are copied
  /// there, so they show with the run's Files. Absent: kept here only.
  filesDir?: string;
}

/// A screenshot's file name from whatever the worker asked for: no folder,
/// plain characters, the right extension. The browser only writes inside
/// its own output folder, so a path is never passed on.
export function screenshotName(asked: unknown, type: unknown, now = Date.now()): string {
  const ext = type === 'jpeg' ? '.jpeg' : '.png';
  const raw = typeof asked === 'string' ? asked.split(/[\\/]/).pop() ?? '' : '';
  let base = '';
  for (const ch of raw) base += /[A-Za-z0-9._-]/.test(ch) ? ch : '-';
  while (base.startsWith('.') || base.startsWith('-')) base = base.slice(1);
  const stem = base.replace(/\.(png|jpe?g)$/i, '').slice(0, 80);
  return `${stem || `screenshot-${now}`}${ext}`;
}

/// Browsing the worker may do itself. Nothing here reads cookies or storage,
/// runs code in the page, sets routes, uploads the server's files or shows a
/// request's headers.
export const SAFE_BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_hover', 'browser_press_key', 'browser_drag', 'browser_drop', 'browser_handle_dialog',
  'browser_wait_for', 'browser_take_screenshot', 'browser_tabs', 'browser_resize', 'browser_console_messages',
  'browser_network_requests', 'browser_find', 'browser_generate_locator', 'browser_verify_element_visible',
  'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value', 'browser_close',
]);

/// How long a sign-in gets to leave the sign-in page.
const SIGN_IN_WAIT_MS = 30_000;
/// Where a sign-in page says what went wrong.
const SIGN_IN_ERRORS = '[role="alert"], [aria-live="assertive"], [aria-live="polite"], .invalid-feedback, [class*="error" i], [class*="alert" i], [class*="toast" i], [class*="snackbar" i]';

/// Playwright, saying it has no browser to start.
export function browserMissing(text: string): boolean {
  return ['browser_install', 'Executable doesn', 'not installed', 'is not found at', 'playwright install'].some((w) => text.includes(w));
}

/// What to do about it, for an admin.
export const NO_BROWSER =
  'This server has no browser for apps to test yet. The Docker image installs Chromium when it is built: rebuild it from this version (without INSTALL_BROWSER=0). Anywhere else, run: npx playwright install --with-deps chromium';

/// Signing in again when a page lands on the sign-in page, at most this often
/// per open: a sign-in that never sticks would otherwise loop.
export const MAX_SIGN_INS_AGAIN = 3;
const POLL_MS = 5000;

const OWN_TOOLS: ToolInfo[] = [
  {
    name: 'list_systems',
    description: 'The apps you may test: each one’s name, address, whether it has per-ticket feature environments, and what to check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_system',
    description:
      'Open an app in the browser, signed in, ready to test. Waits for the environment to be up first. Then use the browser tools. ' +
      'For a feature environment, pass the ticket key, the branch name or the address the deploy gave; leave it out for the app’s usual environment. ' +
      'You never need the app’s password: signing in is done for you, and done again if the session runs out.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'The app’s name, from list_systems.' },
        environment: { type: 'string', description: 'A ticket key, a branch name, or the feature environment’s address. Optional.' },
      },
      required: ['system'],
    },
  },
  {
    name: 'sign_in_again',
    description: 'Sign in to the open app again, and reopen the page you were on. Use it if you end up signed out and it wasn’t done for you.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/// What run code returned: the first line of a Playwright MCP result's
/// `### Result` section, unquoted.
export function resultValue(result: ToolResult): string | undefined {
  for (const c of result.content) {
    if (typeof c.text !== 'string') continue;
    const at = c.text.indexOf('### Result');
    if (at < 0) continue;
    const line = c.text.slice(at + 10).trim().split('\n')[0]?.trim() ?? '';
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      return typeof v === 'string' ? v : line;
    } catch {
      return line;
    }
  }
  return undefined;
}

/// The page a Playwright MCP result says the browser is on.
export function pageUrlOf(result: ToolResult): string | undefined {
  for (const c of result.content) {
    if (typeof c.text !== 'string') continue;
    const at = c.text.indexOf('Page URL: ');
    if (at < 0) continue;
    let end = at + 10;
    while (end < c.text.length && !/\s/.test(c.text[end])) end++;
    const url = c.text.slice(at + 10, end);
    if (url) return url;
  }
  return undefined;
}

interface Open {
  system: TestSystem;
  base: string;
  env?: string;
}

export class TestSystemsSession {
  private child: BrowserChild | null = null;
  private starting: Promise<BrowserChild> | null = null;
  private open: Open | null = null;
  private signInsAgain = 0;
  private lastUrl: string | undefined;
  private installTried = false;

  constructor(private readonly deps: SessionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private visible(): TestSystem[] {
    return this.deps.systems().filter((s) => mayOpen(s, this.deps.worker, this.deps.formerNames));
  }

  private browser(): Promise<BrowserChild> {
    if (this.child) return Promise.resolve(this.child);
    if (!this.starting) {
      this.starting = this.deps.startBrowser().then(
        (c) => {
          this.child = c;
          return c;
        },
        (err) => {
          this.starting = null;
          throw err;
        },
      );
    }
    return this.starting;
  }

  /// Every value that must never reach the model, for redacting what the
  /// browser says back.
  private secrets(system?: TestSystem): string[] {
    const all = system ? [system] : this.deps.systems();
    return all.flatMap((s) => {
      const e = credentialEnv(s.id);
      const extra = s.signIn.kind === 'form' ? (s.signIn.extra ?? []).filter((x) => x.secret).map((x) => extraEnv(s.id, x.key)) : [];
      return [e.password, e.code, e.key, ...extra].map((n) => this.deps.secret(n)).filter((v): v is string => !!v && v.length >= 4);
    });
  }

  private redact(result: ToolResult): ToolResult {
    const hide = this.secrets();
    if (!hide.length) return result;
    return {
      ...result,
      content: result.content.map((c) => (typeof c.text === 'string' ? { ...c, text: hide.reduce((t, s) => t.split(s).join('[hidden]'), c.text) } : c)),
    };
  }

  async listTools(): Promise<ToolInfo[]> {
    let passed: ToolInfo[] = [];
    try {
      passed = (await (await this.browser()).listTools()).filter((t) => SAFE_BROWSER_TOOLS.has(t.name));
    } catch {
      // The browser couldn't start: the own tools still say why on use.
    }
    return [...OWN_TOOLS, ...passed];
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'list_systems') return this.listSystems();
      if (name === 'open_system') return await this.openSystem(String(args.system ?? ''), typeof args.environment === 'string' ? args.environment : undefined);
      if (name === 'sign_in_again') return await this.signInAgain();
      if (!SAFE_BROWSER_TOOLS.has(name)) return text(`${name} isn’t available here. Use the browser tools listed, and open_system to get signed in.`, true);
      return await this.forward(name, args);
    } catch (err) {
      return text(this.scrub(err instanceof Error ? err.message : String(err)), true);
    }
  }

  private scrub(t: string): string {
    return this.secrets().reduce((acc, s) => acc.split(s).join('[hidden]'), t).slice(0, 600);
  }

  private listSystems(): ToolResult {
    const systems = this.visible();
    if (!systems.length) return text('No apps to test are set up for you. An admin adds them on Setup → Apps to test.');
    return text(
      systems
        .map((s) =>
          [
            `## ${s.name}`,
            `Address: ${s.url}`,
            s.envPattern ? `Feature environments: ${s.envPattern} — pass the ticket key or branch as environment.` : null,
            s.guide ? `What to check:\n${s.guide}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n'),
    );
  }

  private find(name: string): TestSystem | undefined {
    const key = name.trim().toLowerCase();
    return this.visible().find((s) => s.id === key || s.name.toLowerCase() === key);
  }

  private async openSystem(name: string, environment?: string): Promise<ToolResult> {
    const system = this.find(name);
    if (!system) {
      const names = this.visible().map((s) => s.name);
      return text(names.length ? `No app called “${name}”. You may open: ${names.join(', ')}.` : 'No apps to test are set up for you.', true);
    }
    const where = resolveEnvironment(system, environment);
    if (!where.ok) return text(where.error, true);
    const ready = await this.waitReady(system, where.base);
    if (!ready.ok) return text(ready.error, true);
    this.open = { system, base: where.base, ...(where.env ? { env: where.env } : {}) };
    this.signInsAgain = 0;
    const signed = await this.signIn(this.open);
    if (!signed.ok) return text(signed.error, true);
    const shown = await this.navigate(where.base);
    const intro = [
      `${system.name} is open${where.env ? ` on the ${where.env} environment` : ''} at ${where.base}${system.signIn.kind === 'none' ? '.' : ', signed in.'}`,
      'Use the browser tools from here. If a page sends you to sign in, it is done again for you. Screenshots you take are kept with this run: give one a file name, not a folder.',
      system.guide ? `\nWhat to check:\n${system.guide}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return { ...shown, content: [{ type: 'text', text: intro }, ...shown.content] };
  }

  private async signInAgain(): Promise<ToolResult> {
    if (!this.open) return text('Nothing is open yet. Use open_system first.', true);
    const signed = await this.signIn(this.open);
    if (!signed.ok) return text(signed.error, true);
    const shown = await this.navigate(this.lastUrl ?? this.open.base);
    return { ...shown, content: [{ type: 'text', text: `Signed in to ${this.open.system.name} again.` }, ...shown.content] };
  }

  /// Wait for the environment's health check, when it has one.
  private async waitReady(system: TestSystem, base: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!system.healthPath) return { ok: true };
    const doFetch = this.deps.fetch ?? fetch;
    const limit = (system.readyTimeoutSec ?? 300) * 1000;
    const started = this.now();
    let last = '';
    for (;;) {
      try {
        const res = await doFetch(`${base}${system.healthPath}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        last = `it answered ${res.status}`;
      } catch (err) {
        last = err instanceof Error && err.name === 'TimeoutError' ? 'it didn’t answer' : 'it couldn’t be reached';
      }
      if (this.now() - started + POLL_MS > limit) {
        return { ok: false, error: `${base} isn’t up: after ${Math.round(limit / 1000)} seconds ${last}. If the deploy is still going, try again later; if it failed, that’s the finding.` };
      }
      await this.sleep(POLL_MS);
    }
  }

  private async navigate(url: string): Promise<ToolResult> {
    const result = await this.callBrowser('browser_navigate', { url });
    const at = pageUrlOf(result);
    if (at) this.lastUrl = at;
    return this.redact(result);
  }

  /// A browser call, installing the browser once if it isn't there yet.
  private async callBrowser(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const child = await this.browser();
    const result = await child.callTool(name, args);
    const said = result.content.map((c) => c.text ?? '').join(' ');
    if (!result.isError || !browserMissing(said)) return result;
    if (!this.installTried) {
      this.installTried = true;
      await child.callTool('browser_install', {}).catch(() => undefined);
      const again = await child.callTool(name, args);
      if (!again.isError || !browserMissing(again.content.map((c) => c.text ?? '').join(' '))) return again;
    }
    return text(NO_BROWSER, true);
  }

  private async forward(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const before = this.lastUrl;
    // A file name, never a path: the browser writes only in its own folder.
    let saved: string | undefined;
    if (name === 'browser_snapshot' && 'filename' in args) {
      args = { ...args };
      delete args.filename;
    }
    if (name === 'browser_take_screenshot') {
      saved = screenshotName(args.filename, args.type, this.now());
      args = { ...args, filename: path.join(this.deps.tempDir(), saved) };
    }
    const result = await this.callBrowser(name, args);
    if (saved && !result.isError) return this.redact(this.keep(saved, result));
    const at = pageUrlOf(result);
    if (this.open && at && this.isSignedOut(at)) {
      if (this.signInsAgain >= MAX_SIGN_INS_AGAIN) {
        return text(`${this.open.system.name} keeps signing out (${MAX_SIGN_INS_AGAIN} times since it was opened). The test account may be locked or its session isn’t sticking; tell your manager.`, true);
      }
      this.signInsAgain++;
      const signed = await this.signIn(this.open);
      if (!signed.ok) return text(`The session ran out and signing in again failed: ${signed.error}`, true);
      const back = name === 'browser_navigate' && typeof args.url === 'string' ? args.url : before ?? this.open.base;
      const shown = await this.navigate(back);
      return { ...shown, content: [{ type: 'text', text: `The session had run out, so it was signed in again and ${back} reopened. Do your last step again.` }, ...shown.content] };
    }
    if (at) this.lastUrl = at;
    return this.redact(result);
  }

  /// A screenshot taken: copied to the run's evidence, and the worker told
  /// where it went, by name.
  private keep(name: string, result: ToolResult): ToolResult {
    let said = `Saved the screenshot as ${name}.`;
    const dir = this.deps.filesDir;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        let target = name;
        for (let n = 2; fs.existsSync(path.join(dir, target)); n++) target = name.replace(/(\.[a-z]+)$/, `-${n}$1`);
        fs.copyFileSync(path.join(this.deps.tempDir(), name), path.join(dir, target));
        said = `Saved the screenshot as ${target}, with this run’s files, where people see it on the run’s page. To attach it to a ticket, give the ticket tool this path: ${path.join(dir, target)}`;
      } catch {
        said = `Took the screenshot (${name}), but it couldn’t be kept with this run’s files.`;
      }
    }
    // The browser's reply names the file in its own folder, which no worker
    // can open: never show it, or a later step goes looking for it.
    const dirName = this.deps.tempDir();
    const content = result.content
      .map((c) => (typeof c.text === 'string' ? { ...c, text: c.text.split('\n').filter((line) => !line.includes(dirName) && !line.includes(name)).join('\n') } : c))
      .filter((c) => typeof c.text !== 'string' || c.text.trim());
    const look = 'You can see it here, in this step only: describe what it shows in this step’s output. A later step can’t open it; people see it on the run’s page.';
    return { ...result, content: [{ type: 'text', text: `${said} ${look}` }, ...content] };
  }

  private isSignedOut(url: string): boolean {
    if (!this.open) return false;
    const out = signedOutPath(this.open.system);
    return !!out && this.isOn(url, this.open, out);
  }

  private isOn(url: string, open: Open, prefix: string): boolean {
    try {
      const u = new URL(url);
      return u.origin === new URL(open.base).origin && u.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  }

  private async signIn(open: Open): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = open.system.signIn;
    if (s.kind === 'none') return { ok: true };
    const e = credentialEnv(open.system.id);
    const user = this.deps.secret(e.user);
    const password = this.deps.secret(e.password);
    if (s.kind === 'endpoint') return this.signInByEndpoint(open, s, user, password, this.deps.secret(e.key));
    if (!user || !password) return { ok: false, error: `${open.system.name} has no test account yet. An admin sets one on Setup → Apps to test.` };
    const codeSecret = s.codeField ? this.deps.secret(e.code) : undefined;
    const code = codeSecret ? totp(codeSecret, this.now()) : undefined;
    const q = JSON.stringify;
    const out = signedOutPath(open.system);
    // The extra fields, in order: a secret one's value from the env.
    const extras: string[] = [];
    for (const x of s.extra ?? []) {
      const at = `page.locator(${q(x.selector)}).first()`;
      if (x.action === 'check') {
        extras.push(`  await ${at}.check();`);
        continue;
      }
      const value = x.secret ? this.deps.secret(extraEnv(open.system.id, x.key)) : x.value;
      if (!value) return { ok: false, error: `${open.system.name} has no value for ${x.label} yet. An admin sets it on Setup → Apps to test.` };
      extras.push(x.action === 'select' ? `  await ${at}.selectOption(${q(value)});` : `  await ${at}.fill(${q(value)});`);
    }
    const script = [
      'async (page) => {',
      `  await page.goto(${q(`${open.base}${s.loginPath}`)}, { waitUntil: 'domcontentloaded' });`,
      `  await page.locator(${q(s.userField)}).first().fill(${q(user)});`,
      ...extras,
      // A login over two screens: on to the password's.
      s.nextButton
        ? `  await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator(${q(s.nextButton)}).first().click()]);\n  await page.locator(${q(s.passwordField)}).first().waitFor({ timeout: 20000 });`
        : '',
      `  await page.locator(${q(s.passwordField)}).first().fill(${q(password)});`,
      `  await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator(${q(s.submit)}).first().click()]);`,
      code && s.codeField
        ? `  const c = page.locator(${q(s.codeField)}).first(); if (await c.waitFor({ timeout: 10000 }).then(() => true, () => false)) { await c.fill(${q(code)}); await Promise.all([page.waitForLoadState('load').catch(() => {}), c.press('Enter')]); }`
        : '',
      // A single-page app signs in behind the page, and a slow one takes a
      // while: give it time to leave the sign-in page before calling it failed.
      // If it stays, what the page says is the reason.
      ...(out
        ? [
            `  await page.waitForURL((u) => !u.pathname.startsWith(${q(out)}), { timeout: ${SIGN_IN_WAIT_MS}, waitUntil: 'commit' }).catch(() => {});`,
            `  if (!new URL(page.url()).pathname.startsWith(${q(out)})) return page.url();`,
            `  const said = await page.locator(${q(SIGN_IN_ERRORS)}).allInnerTexts().catch(() => []);`,
            `  return page.url() + '\\n' + [...new Set(said.map((t) => t.trim()).filter(Boolean))].join(' · ').slice(0, 200);`,
          ]
        : ['  await page.waitForTimeout(1000);', '  return page.url();']),
      '}',
    ].join('\n');
    const result = await this.callBrowser('browser_run_code_unsafe', { code: script });
    if (result.isError) return { ok: false, error: `Signing in to ${open.system.name} failed: ${this.scrub(result.content.map((c) => c.text ?? '').join(' ').split('```')[0])}` };
    // Where it ended up: the code's own return value, never the rest of the
    // reply, which echoes the code (and so the sign-in page's address).
    const [at, said] = (resultValue(result) ?? pageUrlOf(result) ?? '').split('\n');
    if (out && this.isOn(at, open, out)) {
      const reason = said?.trim() ? ` The page says: “${this.scrub(said.trim())}”.` : ' The page showed no error.';
      return { ok: false, error: `Still on ${open.system.name}’s sign-in page ${SIGN_IN_WAIT_MS / 1000} seconds after signing in.${reason} The test account may be wrong or locked, or the fields have changed; an admin can check on Setup → Apps to test.` };
    }
    return { ok: true };
  }

  private async signInByEndpoint(
    open: Open,
    s: Extract<TestSystem['signIn'], { kind: 'endpoint' }>,
    user: string | undefined,
    password: string | undefined,
    key: string | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${open.base}${s.path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ ...(user ? { username: user } : {}), ...(password ? { password } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { ok: false, error: `${open.system.name}’s test login at ${s.path} couldn’t be reached.` };
    }
    if (res.status >= 400) return { ok: false, error: `${open.system.name}’s test login answered ${res.status}. Check the test account and key on Setup → Apps to test.` };
    const host = new URL(open.base).hostname;
    const cookies = parseSetCookies(res.headers.getSetCookie?.() ?? [], host);
    let token: string | undefined;
    if (s.tokenKey) {
      try {
        const body = (await res.json()) as { token?: unknown };
        if (typeof body.token === 'string') token = body.token;
      } catch {
        // No JSON: cookies only.
      }
    }
    if (!cookies.length && !token) return { ok: false, error: `${open.system.name}’s test login answered but set no session.` };
    const state = { cookies, origins: token && s.tokenKey ? [{ origin: new URL(open.base).origin, localStorage: [{ name: s.tokenKey, value: token }] }] : [] };
    const dir = this.deps.tempDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `session-${crypto.randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    try {
      const loaded = await this.callBrowser('browser_set_storage_state', { filename: file });
      if (loaded.isError) return { ok: false, error: `The session from ${open.system.name}’s test login couldn’t be loaded into the browser.` };
    } finally {
      fs.rmSync(file, { force: true });
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    const c = this.child;
    this.child = null;
    this.starting = null;
    if (c) await c.close().catch(() => {});
  }
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/// Set-Cookie headers as Playwright storage-state cookies.
export function parseSetCookies(headers: string[], host: string): PlaywrightCookie[] {
  const out: PlaywrightCookie[] = [];
  for (const header of headers) {
    const parts = header.split(';').map((p) => p.trim());
    const first = parts.shift() ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const cookie: PlaywrightCookie = { name: first.slice(0, eq), value: first.slice(eq + 1), domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
    for (const p of parts) {
      const at = p.indexOf('=');
      const k = (at < 0 ? p : p.slice(0, at)).toLowerCase();
      const v = at < 0 ? '' : p.slice(at + 1);
      if (k === 'domain' && v) cookie.domain = v.startsWith('.') ? v : `.${v}`;
      else if (k === 'path' && v) cookie.path = v;
      else if (k === 'max-age' && v) cookie.expires = Math.floor(Date.now() / 1000) + Number(v);
      else if (k === 'expires' && v && cookie.expires === -1) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
      } else if (k === 'httponly') cookie.httpOnly = true;
      else if (k === 'secure') cookie.secure = true;
      else if (k === 'samesite') cookie.sameSite = v.toLowerCase() === 'strict' ? 'Strict' : v.toLowerCase() === 'none' ? 'None' : 'Lax';
    }
    out.push(cookie);
  }
  return out;
}
