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
// Credentials only ever go to an address `resolveEnvironment` allows. And the
// browser itself goes nowhere private the worker picks: an address that is,
// or resolves to, loopback, a private network, link-local (cloud metadata) or
// the like is refused, before the browser goes and wherever it ends up,
// unless it is one of the apps' own environments (those may well be on a
// private network).

import fs from 'node:fs';
import net from 'node:net';
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

/// A video's file name, on the same terms as a screenshot's: always `.webm`.
export function videoName(asked: unknown, now = Date.now()): string {
  const raw = typeof asked === 'string' ? asked.split(/[\\/]/).pop() ?? '' : '';
  let base = '';
  for (const ch of raw) base += /[A-Za-z0-9._-]/.test(ch) ? ch : '-';
  while (base.startsWith('.') || base.startsWith('-')) base = base.slice(1);
  const stem = base.replace(/\.(webm|mp4|mov)$/i, '').slice(0, 80);
  return `${stem || `video-${now}`}.webm`;
}

/// The largest video kept with a run. A whole test at 1280×720 comes out at
/// a few MB a minute; one past this was left running.
export const MAX_VIDEO_BYTES = 150_000_000;
/// What a recording is made at: enough to read the page, small enough to keep.
export const VIDEO_SIZE = { width: 1280, height: 720 };
const VIDEO_FPS = 15;

/// Browsing the worker may do itself. Nothing here reads cookies or storage,
/// runs code in the page, sets routes, uploads the server's files or shows a
/// request's headers.
export const SAFE_BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_hover', 'browser_press_key', 'browser_drag', 'browser_drop', 'browser_handle_dialog',
  'browser_wait_for', 'browser_take_screenshot', 'browser_tabs', 'browser_resize', 'browser_console_messages',
  'browser_network_requests', 'browser_find', 'browser_generate_locator', 'browser_verify_element_visible',
  'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value', 'browser_close',
  // A title card in the video being recorded (start_video), between parts of a test.
  'browser_video_chapter',
]);

/// A value as a string literal in a script run in the browser. JSON keeps it
/// inside its quotes, and these characters are escaped as well so the text can
/// never close a surrounding script or end a line, wherever the script ends up.
export function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/// How long a sign-in gets to leave the sign-in page.
const SIGN_IN_WAIT_MS = 30_000;
/// Where a sign-in page says what went wrong.
const SIGN_IN_ERRORS = '[role="alert"], [aria-live="assertive"], [aria-live="polite"], .invalid-feedback, [class*="error" i], [class*="alert" i], [class*="toast" i], [class*="snackbar" i]';

/// Playwright, saying it has no browser to start. Not its ffmpeg, which only
/// video needs: the browser is there, and start_video says so itself.
export function browserMissing(text: string): boolean {
  if (/ffmpeg/i.test(text)) return false;
  return ['browser_install', 'Executable doesn', 'not installed', 'is not found at', 'playwright install'].some((w) => text.includes(w));
}

/// What to do about it, for an admin.
export const NO_BROWSER =
  'This server has no browser for apps to test yet. The Docker image installs Chromium when it is built: rebuild it from this version (without INSTALL_BROWSER=0). Anywhere else, run: npx playwright install --with-deps chromium';

/// A screenshot file this small is almost one flat colour: a page still
/// behind its loading screen, or blank. Real pages come out at tens of KB.
export const LIKELY_BLANK_BYTES = 20_000;
/// How long to give such a page before taking it once more.
export const BLANK_RETRY_MS = 2500;
/// The largest screenshot sent back for the worker to look at; a bigger one
/// (a very long full page) is still kept, just not shown.
export const MAX_INLINE_IMAGE_BYTES = 3_500_000;

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
  {
    name: 'start_video',
    description:
      'Start recording the browser as a video, for people to watch the test you run. Start it before the first step of the test and stop it with stop_video when the test is done. ' +
      'Mark each part of the test (each acceptance criterion, say) with browser_video_chapter. Signing in is never recorded: recording pauses while it happens, and carries on in a next part.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A file name for the video, such as the ticket key: BILL-123-checkout. No folder.' },
        cursor: { type: 'boolean', description: 'Show a mouse pointer moving to each click, so the video is easy to follow. On unless you turn it off; it slows each action a little.' },
      },
    },
  },
  {
    name: 'stop_video',
    description: 'Stop the recording started with start_video and keep it with this run’s files, where people watch it on the run’s page. Says where it was kept, to attach it to a ticket.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/// What the browser's proxy (browserProxy.ts) answers a refused request with:
/// a refusal that names itself, so it isn't read as the app being down.
export const REFUSED_MARK = 'Refused by the test-systems browser proxy:';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/// Addresses the browser never goes to unless they are an app's own: the
/// unspecified, loopback, private (RFC 1918, CGNAT), link-local (where cloud
/// metadata answers), benchmarking, multicast and reserved ranges, and their
/// IPv6 kin (unique-local, link-local, multicast).
const BLOCKED = (() => {
  const b = new net.BlockList();
  for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) b.addSubnet(a, n, 'ipv4');
  for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) b.addSubnet(a, n, 'ipv6');
  return b;
})();

/// The eight 16-bit groups of an IPv6 address, or null.
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) as two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[1])) return null;
    const [a, b, c, d] = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/// Whether the browser is kept away from this address. IPv4 written as IPv6
/// (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`)
/// is judged as the IPv4 address it carries.
export function blockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return BLOCKED.check(bare, 'ipv4');
  if (!net.isIPv6(bare)) return true;
  const g = ipv6Groups(bare);
  if (!g) return true;
  const embedded =
    (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded && (g[6] || g[7] || g[5] === 0xffff)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return BLOCKED.check(v4, 'ipv4');
  }
  return BLOCKED.check(bare, 'ipv6');
}

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

/// A video being recorded: the name asked for, which part (a sign-in ends
/// one part and starts the next), and the parts already kept.
interface Recording {
  name: string;
  cursor: boolean;
  part: number;
  file: string;
  since: number;
  kept: Array<{ name: string; path?: string; bytes: number }>;
  problems: string[];
}

export class TestSystemsSession {
  private child: BrowserChild | null = null;
  private starting: Promise<BrowserChild> | null = null;
  private open: Open | null = null;
  private signInsAgain = 0;
  private lastUrl: string | undefined;
  private installTried = false;
  private recording: Recording | null = null;

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
      if (name === 'start_video') return await this.startVideo(args);
      if (name === 'stop_video') return await this.stopVideo();
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
      this.recording
        ? 'The video you started is still recording.'
        : 'To keep a video of the test for people to watch, start_video before its first step and stop_video when it is done.',
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

  /// Why the browser may not go to `raw`, or null when it may: an app's own
  /// environment always may; otherwise only http(s), and never an address
  /// written out that is private, loopback or link-local. A name isn't looked
  /// up here: the browser's proxy (browserProxy.ts) looks each one up as it
  /// connects, for every request a page makes, and connects to the address
  /// it checked. This is the quick answer for what can be judged by reading.
  async refusedAddress(raw: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return `“${raw.slice(0, 200)}” isn’t an address the browser can open.`;
    }
    if (u.href === 'about:blank') return null;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `The browser only opens http and https addresses, not ${u.protocol}.`;
    for (const s of this.visible()) if (resolveEnvironment(s, u.origin).ok) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const refuse = `${u.host} is on a private network (or this server), so the browser doesn’t go there. Only the apps’ own environments may be private; open one with open_system.`;
    if (host === 'localhost' || host.endsWith('.localhost')) return refuse;
    if (net.isIP(host) && blockedAddress(host)) return refuse;
    return null;
  }

  private async forward(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Where the worker asks the browser to go is checked first…
    const asked = (name === 'browser_navigate' || name === 'browser_tabs') && typeof args.url === 'string' ? args.url : null;
    if (asked !== null) {
      const why = await this.refusedAddress(asked);
      if (why) return text(why, true);
    }
    const result = await this.forwardChecked(name, args);
    // The proxy refused a connection the page needed: say why, so it isn't
    // read as the app being down.
    const said = result.content.map((c) => c.text ?? '').join(' ');
    if (/ERR_TUNNEL_CONNECTION_FAILED/.test(said) || said.includes(REFUSED_MARK)) {
      result.content.push({ type: 'text', text: 'That address was refused by the browser’s proxy: it is on a private network (or this server), and only the apps’ own environments may be. Open an app with open_system.' });
    }
    // …and where it ended up (a redirect, a link clicked): a private page
    // isn't shown, and the browser is taken off it.
    const at = pageUrlOf(result);
    if (at) {
      const why = await this.refusedAddress(at);
      if (why) {
        await this.callBrowser('browser_navigate', { url: 'about:blank' }).catch(() => undefined);
        this.lastUrl = undefined;
        return text(`The page left for an address the browser doesn’t open, so it isn’t shown. ${why}`, true);
      }
    }
    return result;
  }

  private async forwardChecked(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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
    let result = await this.callBrowser(name, args);
    if (saved && !result.isError) {
      // A screenshot taken while the app is still behind its loading screen:
      // a wait for text can pass on text already in the page underneath it.
      // Give it a moment and take it once more, and say so if it's no better.
      let blank = this.looksBlank(saved);
      if (blank) {
        await this.sleep(BLANK_RETRY_MS);
        const again = await this.callBrowser(name, args);
        if (!again.isError) result = again;
        blank = this.looksBlank(saved);
      }
      return this.redact(this.keep(saved, result, blank));
    }
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
  private keep(name: string, result: ToolResult, blank = false): ToolResult {
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
    // Playwright returns the picture only when it isn't given a file name, and
    // it always is one here: send the picture back from the file.
    let image: ToolContent | undefined;
    if (!content.some((c) => c.type === 'image')) {
      try {
        const file = path.join(dirName, name);
        if (fs.statSync(file).size <= MAX_INLINE_IMAGE_BYTES) {
          image = { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png' };
        }
      } catch {
        // Not readable: the worker is told it can't see it, below.
      }
    }
    const seen = image || content.some((c) => c.type === 'image');
    const look = seen
      ? 'It is shown below, in this step only: look at it and describe what it shows in this step’s output. A later step can’t open it; people see it on the run’s page.'
      : 'It is too large to show here; people see it on the run’s page.';
    const warn = blank
      ? ' It is almost empty, even taken a second time a moment later: the page is likely still loading or blank. Don’t use it as evidence. Wait for something only the loaded page shows, then take it again.'
      : '';
    return { ...result, content: [{ type: 'text', text: `${said} ${look}${warn}` }, ...content, ...(image ? [image] : [])] };
  }

  /// The screenshot just taken, in the browser's folder, is suspiciously small.
  private looksBlank(name: string): boolean {
    try {
      return fs.statSync(path.join(this.deps.tempDir(), name)).size < LIKELY_BLANK_BYTES;
    } catch {
      return false;
    }
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

  /// Sign in, never on camera: a form sign-in shows the test account's name
  /// and its authenticator code as they are typed, so a recording stops
  /// before it (the part so far is kept) and starts again, as its next part,
  /// once it's done.
  private async signIn(open: Open): Promise<{ ok: true } | { ok: false; error: string }> {
    const paused = this.recording && open.system.signIn.kind === 'form' ? await this.endPart() : false;
    try {
      return await this.signInNow(open);
    } finally {
      if (paused && this.recording) {
        this.recording.part++;
        const started = await this.startPart(this.recording);
        if (started) this.recording.problems.push(`Recording couldn’t carry on after signing in: ${started}`);
      }
    }
  }

  // ---- VIDEO ---------------------------------------------------------------

  private async startVideo(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.recording) return text('A video is already recording. Stop it with stop_video before starting another.', true);
    const rec: Recording = {
      name: videoName(args.name, this.now()),
      cursor: args.cursor !== false,
      part: 1,
      file: '',
      since: this.now(),
      kept: [],
      problems: [],
    };
    const failed = await this.startPart(rec);
    if (failed) return text(`The video didn’t start: ${failed}`, true);
    this.recording = rec;
    return text(`Recording ${rec.name}. Do the test, marking each part with browser_video_chapter, then stop_video. Signing in is never recorded.`);
  }

  /// Start recording one part, into the browser's own folder. A reason it
  /// didn't start, or null.
  private async startPart(rec: Recording): Promise<string | null> {
    const name = rec.part === 1 ? rec.name : rec.name.replace(/\.webm$/, `-part${rec.part}.webm`);
    rec.file = path.join(this.deps.tempDir(), name);
    rec.since = this.now();
    const res = await this.callBrowser('browser_start_video', { filename: rec.file, size: VIDEO_SIZE, fps: VIDEO_FPS, cursor: rec.cursor });
    if (!res.isError) return null;
    const said = this.scrub(res.content.map((c) => c.text ?? '').join(' '));
    return /ffmpeg/i.test(said) ? 'this server can’t record video (Playwright’s ffmpeg isn’t installed). Take screenshots instead, and tell your manager.' : said;
  }

  /// Stop the part being recorded and keep it. Whether a part was stopped.
  private async endPart(): Promise<boolean> {
    const rec = this.recording;
    if (!rec) return false;
    const res = await this.callBrowser('browser_stop_video', {}).catch((err: unknown) => text(err instanceof Error ? err.message : String(err), true));
    const made = this.videoFiles(rec, res);
    if (!made.length) rec.problems.push(res.isError ? `Part ${rec.part} couldn’t be saved: ${this.scrub(res.content.map((c) => c.text ?? '').join(' '))}` : `Part ${rec.part} came out with nothing in it.`);
    for (const file of made) {
      const kept = this.keepVideo(file);
      if (typeof kept === 'string') rec.problems.push(kept);
      else rec.kept.push(kept);
    }
    return true;
  }

  /// The video files a stop made: the one asked for, or, if the browser put
  /// it elsewhere in its folder, the .webm files written since it started.
  private videoFiles(rec: Recording, res: ToolResult): string[] {
    if (fs.existsSync(rec.file)) return [rec.file];
    const dir = this.deps.tempDir();
    const named = res.content.flatMap((c) => (typeof c.text === 'string' ? [...c.text.matchAll(/[^\s()[\]"'`]+\.webm/g)].map((m) => m[0]) : []));
    const listed = (() => {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.webm')).map((f) => path.join(dir, f));
      } catch {
        return [];
      }
    })();
    const known = new Set(rec.kept.map((k) => k.name));
    return [...new Set([...named.map((n) => (path.isAbsolute(n) ? n : path.join(dir, n))), ...listed])].filter((f) => {
      try {
        return path.dirname(path.resolve(f)) === path.resolve(dir) && !known.has(path.basename(f)) && fs.statSync(f).mtimeMs >= rec.since - 2000;
      } catch {
        return false;
      }
    });
  }

  /// A finished video part, copied to the run's files and taken out of the
  /// browser's folder. What was kept, or why it wasn't.
  private keepVideo(file: string): { name: string; path?: string; bytes: number } | string {
    const name = path.basename(file);
    try {
      const bytes = fs.statSync(file).size;
      if (!bytes) return `${name} came out empty.`;
      if (bytes > MAX_VIDEO_BYTES) return `${name} is over ${Math.round(MAX_VIDEO_BYTES / 1_000_000)} MB, so it wasn’t kept. Record a shorter test.`;
      const dir = this.deps.filesDir;
      if (!dir) return { name, bytes };
      fs.mkdirSync(dir, { recursive: true });
      let target = name;
      for (let n = 2; fs.existsSync(path.join(dir, target)); n++) target = name.replace(/(\.webm)$/, `-${n}$1`);
      fs.copyFileSync(file, path.join(dir, target));
      fs.rmSync(file, { force: true });
      return { name: target, path: path.join(dir, target), bytes };
    } catch {
      return `${name} couldn’t be kept with this run’s files.`;
    }
  }

  private async stopVideo(): Promise<ToolResult> {
    const rec = this.recording;
    if (!rec) return text('No video is recording. Start one with start_video.', true);
    await this.endPart();
    this.recording = null;
    const mb = (b: number) => `${Math.max(0.1, Math.round(b / 100_000) / 10)} MB`;
    const lines: string[] = [];
    if (rec.kept.length) {
      lines.push(
        rec.kept.length === 1
          ? `Saved the video as ${rec.kept[0].name} (${mb(rec.kept[0].bytes)})${rec.kept[0].path ? ', with this run’s files, where people watch it on the run’s page' : ''}.`
          : `Saved the video in ${rec.kept.length} parts, split where signing in paused it: ${rec.kept.map((k) => `${k.name} (${mb(k.bytes)})`).join(', ')}${rec.kept[0].path ? '. They are with this run’s files, where people watch them on the run’s page' : ''}.`,
      );
      const paths = rec.kept.flatMap((k) => (k.path ? [k.path] : []));
      if (paths.length) lines.push(`To attach ${paths.length === 1 ? 'it' : 'them'} to a ticket, give the ticket tool ${paths.length === 1 ? 'this path' : 'these paths'}: ${paths.join(', ')}`);
      lines.push('You can’t watch it yourself: say in this step’s output what the test showed, step by step, and that the video shows it.');
    }
    lines.push(...rec.problems);
    return text(lines.join('\n') || 'No video was saved.', !rec.kept.length);
  }

  private async signInNow(open: Open): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = open.system.signIn;
    if (s.kind === 'none') return { ok: true };
    const e = credentialEnv(open.system.id);
    const user = this.deps.secret(e.user);
    const password = this.deps.secret(e.password);
    if (s.kind === 'endpoint') return this.signInByEndpoint(open, s, user, password, this.deps.secret(e.key));
    if (!user || !password) return { ok: false, error: `${open.system.name} has no test account yet. An admin sets one on Setup → Apps to test.` };
    const codeSecret = s.codeField ? this.deps.secret(e.code) : undefined;
    const code = codeSecret ? totp(codeSecret, this.now()) : undefined;
    const q = jsLiteral;
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
    // A run that ended with a video still recording keeps what was recorded.
    if (this.recording && this.child) {
      await Promise.race([this.endPart(), new Promise((r) => setTimeout(r, 15_000))]).catch(() => undefined);
      this.recording = null;
    }
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
