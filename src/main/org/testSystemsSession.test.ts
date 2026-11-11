import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { credentialEnv, extraEnv, type TestSystem } from '../../shared/testSystems';
import { BLANK_RETRY_MS, LIKELY_BLANK_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_SIGN_INS_AGAIN, TestSystemsSession, jsLiteral, pageUrlOf, parseSetCookies, resultValue, screenshotName, type BrowserChild, type ToolResult } from './testSystemsSession';

const billing: TestSystem = {
  id: 'billing',
  name: 'Billing',
  url: 'https://staging.billing.acme.dev',
  envPattern: 'https://{env}.feature.billing.acme.dev',
  signIn: { kind: 'form', loginPath: '/login', userField: '#email', passwordField: '#password', submit: 'button' },
  guide: 'Check invoices.',
  workers: [],
};
const E = credentialEnv('billing');
const SECRETS: Record<string, string> = { [E.user]: 'qa@acme.dev', [E.password]: 'hunter2-secret', [E.key]: 'qa-key-123', [extraEnv('billing', 'pin')]: 'pin-98765' };

/// A screenshot the size of a real page's.
const PAGE_PNG = Buffer.alloc(LIKELY_BLANK_BYTES + 5000, 3);

const page = (url: string, extra = ''): ToolResult => ({ content: [{ type: 'text', text: `### Page\n- Page URL: ${url}\n- Page Title: x\n${extra}` }] });

function fakeBrowser(onCall: (name: string, args: Record<string, unknown>) => ToolResult) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const child: BrowserChild = {
    listTools: async () => ['browser_navigate', 'browser_click', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_cookie_list', 'browser_snapshot'].map((name) => ({ name, inputSchema: { type: 'object' } })),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return onCall(name, args);
    },
    close: async () => {},
  };
  return { child, calls };
}

function session(systems: TestSystem[], browser: BrowserChild, more: { worker?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  return new TestSystemsSession({
    systems: () => systems,
    secret: (n) => SECRETS[n],
    startBrowser: async () => browser,
    tempDir: () => path.join(os.tmpdir(), 'overcli-ts-test'),
    sleep: async () => {},
    ...more,
  });
}

describe('a value in the sign-in script', () => {
  it('stays the same value, and can’t break out of its quotes', () => {
    for (const v of ['pa"ss\\word', "it's", '</script><script>alert(1)</script>', 'a\nb', 'x\u2028y\u2029z', 'button:has-text("Log In")', '#a > .b']) {
      const literal = jsLiteral(v);
      expect(literal).not.toMatch(/[<>\u2028\u2029\n]/);
      expect(new Function(`return ${literal}`)()).toBe(v);
    }
  });
});

describe('the test-systems tool', () => {
  it('passes through only safe browsing, and refuses the rest', async () => {
    const { child, calls } = fakeBrowser(() => page('https://x'));
    const s = session([billing], child);
    const names = (await s.listTools()).map((t) => t.name);
    expect(names).toEqual(['list_systems', 'open_system', 'sign_in_again', 'browser_navigate', 'browser_click', 'browser_snapshot']);
    for (const blocked of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_cookie_list', 'browser_storage_state']) {
      expect((await s.call(blocked, {})).isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('signs in on a feature environment by filling the form, and never says the password', async () => {
    const { child, calls } = fakeBrowser((name, args) =>
      name === 'browser_run_code_unsafe' ? { content: [{ type: 'text', text: '### Result\n"https://bill-7.feature.billing.acme.dev/home"\n### Ran Playwright code\n```js\n' + String(args.code) + '\n```' }] } : page(String(args.url ?? '')),
    );
    const res = await session([billing], child).call('open_system', { system: 'billing', environment: 'BILL-7' });
    expect(res.isError).toBeUndefined();
    const all = JSON.stringify(res);
    expect(all).toContain('Billing is open on the bill-7 environment at https://bill-7.feature.billing.acme.dev, signed in.');
    expect(all).toContain('Check invoices.');
    expect(all).not.toContain('hunter2-secret');
    const code = String(calls[0].args.code);
    expect(calls[0].name).toBe('browser_run_code_unsafe');
    expect(code).toContain('"https://bill-7.feature.billing.acme.dev/login"');
    expect(code).toContain('"hunter2-secret"');
    expect(calls[1]).toEqual({ name: 'browser_navigate', args: { url: 'https://bill-7.feature.billing.acme.dev' } });
  });

  it('fills extra fields in order, presses Next, then the password', async () => {
    const sys: TestSystem = { ...billing, signIn: { ...(billing.signIn as Extract<TestSystem['signIn'], { kind: 'form' }>), nextButton: '#next', extra: [
      { label: 'Tenant', key: 'tenant', selector: '#tenant', action: 'select', value: 'acme' },
      { label: 'PIN', key: 'pin', selector: '#pin', action: 'fill', secret: true },
      { label: 'Remember me', key: 'remember-me', selector: '#remember', action: 'check' },
    ] } };
    const { child, calls } = fakeBrowser((name, args) => (name === 'browser_run_code_unsafe' ? { content: [{ type: 'text', text: '### Result\n"https://staging.billing.acme.dev/home"' }] } : page(String(args.url ?? ''), 'textbox "PIN" value="pin-98765"')));
    const res = await session([sys], child).call('open_system', { system: 'billing' });
    expect(res.isError).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('pin-98765');
    const code = String(calls[0].args.code);
    const order = ['fill("qa@acme.dev")', 'selectOption("acme")', 'fill("pin-98765")', '.check()', '"#next"', 'waitFor({ timeout: 20000 })', 'fill("hunter2-secret")'].map((x) => code.indexOf(x));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says which extra field has no value yet', async () => {
    const sys: TestSystem = { ...billing, id: 'portal', signIn: { ...(billing.signIn as Extract<TestSystem['signIn'], { kind: 'form' }>), extra: [{ label: 'PIN', key: 'pin', selector: '#pin', action: 'fill', secret: true }] } };
    const P = credentialEnv('portal');
    Object.assign(SECRETS, { [P.user]: 'u', [P.password]: 'portal-pass' });
    const { child, calls } = fakeBrowser(() => page('https://x'));
    const res = await session([sys], child).call('open_system', { system: 'portal' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('no value for PIN');
    expect(calls).toEqual([]);
  });

  it('tries installing a missing browser once, then says how to fix it', async () => {
    const { child, calls } = fakeBrowser(() => ({ isError: true, content: [{ type: 'text', text: "Error: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome" }] }));
    const res = await session([{ ...billing, signIn: { kind: 'none' } }], child).call('open_system', { system: 'billing' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('npx playwright install --with-deps chromium');
    expect(calls.map((c) => c.name)).toEqual(['browser_navigate', 'browser_install', 'browser_navigate']);
  });

  it('sends nothing to an address outside the app', async () => {
    const { child, calls } = fakeBrowser(() => page('https://x'));
    const res = await session([billing], child).call('open_system', { system: 'Billing', environment: 'https://evil.example' });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('says so when the sign-in doesn’t stick', async () => {
    const { child } = fakeBrowser((name) => (name === 'browser_run_code_unsafe' ? { content: [{ type: 'text', text: '### Result\n"https://staging.billing.acme.dev/login?error=1"' }] } : page('https://x')));
    const res = await session([billing], child).call('open_system', { system: 'billing' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('Still on Billing’s sign-in page');
  });

  it('gives a slow sign-in time to leave the page, and passes on what the page says if it stays', async () => {
    const { child, calls } = fakeBrowser((name) =>
      name === 'browser_run_code_unsafe' ? { content: [{ type: 'text', text: '### Result\n"https://staging.billing.acme.dev/login\\nInvalid password hunter2-secret"' }] } : page('https://x'),
    );
    const res = await session([billing], child).call('open_system', { system: 'billing' });
    const said = JSON.stringify(res);
    expect(res.isError).toBe(true);
    expect(said).toContain('The page says: “Invalid password [hidden]”');
    expect(said).not.toContain('hunter2-secret');
    const code = String(calls[0].args.code);
    expect(code).toContain('page.waitForURL');
    expect(code).toContain('startsWith("/login")');
    // It must run as a script in the browser: the newline stays escaped.
    expect(code).toContain("'\\n'");
  });

  it('says so when the sign-in page showed no reason', async () => {
    const { child } = fakeBrowser((name) => (name === 'browser_run_code_unsafe' ? { content: [{ type: 'text', text: '### Result\n"https://staging.billing.acme.dev/login\\n"' }] } : page('https://x')));
    expect(JSON.stringify(await session([billing], child).call('open_system', { system: 'billing' }))).toContain('The page showed no error.');
  });

  it('signs in again when a page lands on the sign-in page, reopens it, and gives up after a few', async () => {
    let expired = false;
    const { child, calls } = fakeBrowser((name, args) => {
      if (name === 'browser_run_code_unsafe') return { content: [{ type: 'text', text: '### Result\n"https://staging.billing.acme.dev/home"\n### Ran Playwright code\nawait page.goto("https://staging.billing.acme.dev/login")' }] };
      if (name === 'browser_click' && expired) return page('https://staging.billing.acme.dev/login?next=/invoices');
      return page(String(args.url ?? 'https://staging.billing.acme.dev/invoices'));
    });
    const s = session([billing], child);
    await s.call('open_system', { system: 'billing' });
    await s.call('browser_navigate', { url: 'https://staging.billing.acme.dev/invoices' });
    expired = true;
    const res = await s.call('browser_click', { ref: 'e1' });
    expect(JSON.stringify(res)).toContain('The session had run out, so it was signed in again and https://staging.billing.acme.dev/invoices reopened.');
    expect(calls.filter((c) => c.name === 'browser_run_code_unsafe')).toHaveLength(2);
    for (let i = 1; i < MAX_SIGN_INS_AGAIN; i++) await s.call('browser_click', { ref: 'e1' });
    const last = await s.call('browser_click', { ref: 'e1' });
    expect(last.isError).toBe(true);
    expect(JSON.stringify(last)).toContain('keeps signing out');
  });

  it('waits for the environment’s health check, and says when it never comes up', async () => {
    let t = 0;
    let answers = [503, 503, 200];
    const fetchFake = (async () => ({ status: answers.shift() ?? 503 }) as Response) as unknown as typeof fetch;
    const sys = { ...billing, healthPath: '/health', readyTimeoutSec: 60, signIn: { kind: 'none' as const } };
    const { child } = fakeBrowser((_n, args) => page(String(args.url)));
    expect((await session([sys], child, { fetch: fetchFake, now: () => (t += 5000) }).call('open_system', { system: 'billing' })).isError).toBeUndefined();
    answers = [];
    const res = await session([sys], child, { fetch: fetchFake, now: () => (t += 5000) }).call('open_system', { system: 'billing' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('isn’t up');
  });

  it('signs in through a test login endpoint and loads its session', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { status: 200, headers: { getSetCookie: () => ['sid=abc; Path=/; HttpOnly; Secure; SameSite=Strict'] }, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const sys: TestSystem = { ...billing, signIn: { kind: 'endpoint', path: '/test/login' } };
    const { child, calls } = fakeBrowser((_n, args) => page(String(args.url ?? '')));
    const res = await session([sys], child, { fetch: fetchFake }).call('open_system', { system: 'billing', environment: 'bill-2' });
    expect(res.isError).toBeUndefined();
    expect(seen[0].url).toBe('https://bill-2.feature.billing.acme.dev/test/login');
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer qa-key-123');
    expect(calls[0].name).toBe('browser_set_storage_state');
    expect(JSON.stringify(res)).not.toContain('qa-key-123');
  });

  it('shows each worker only the apps it may open', async () => {
    const { child } = fakeBrowser(() => page('https://x'));
    const only = { ...billing, workers: ['QA Bot'] };
    expect(JSON.stringify(await session([only], child, { worker: 'Analyst' }).call('list_systems', {}))).toContain('No apps to test');
    expect(JSON.stringify(await session([only], child, { worker: 'QA Bot' }).call('list_systems', {}))).toContain('## Billing');
    expect((await session([only], child, { worker: 'Analyst' }).call('open_system', { system: 'billing' })).isError).toBe(true);
  });

  it('hides a password the page shows back', async () => {
    const { child } = fakeBrowser(() => page('https://x', 'textbox "Password" value="hunter2-secret"'));
    const res = await session([billing], child).call('browser_snapshot', {});
    expect(JSON.stringify(res)).not.toContain('hunter2-secret');
    expect(JSON.stringify(res)).toContain('[hidden]');
  });
});

describe('the pieces', () => {
  it('reads what run code returned, not the code it echoes', () => {
    expect(resultValue({ content: [{ type: 'text', text: '### Result\n"https://a.acme.dev/home"\n### Ran Playwright code\ngoto("https://a.acme.dev/login")' }] })).toBe('https://a.acme.dev/home');
    expect(resultValue({ content: [{ type: 'text', text: 'no result' }] })).toBeUndefined();
  });

  it('reads the page a result is on', () => {
    expect(pageUrlOf(page('https://a.acme.dev/x?y=1'))).toBe('https://a.acme.dev/x?y=1');
    expect(pageUrlOf({ content: [{ type: 'text', text: 'nothing' }] })).toBeUndefined();
  });

  it('turns Set-Cookie into Playwright cookies', () => {
    const [c] = parseSetCookies(['sid=a=b; Domain=acme.dev; Path=/app; HttpOnly; Secure; SameSite=None; Max-Age=60'], 'x.acme.dev');
    expect(c).toMatchObject({ name: 'sid', value: 'a=b', domain: '.acme.dev', path: '/app', httpOnly: true, secure: true, sameSite: 'None' });
    expect(c.expires).toBeGreaterThan(Date.now() / 1000);
    expect(parseSetCookies(['junk'], 'x')).toEqual([]);
  });
});

describe('screenshots', () => {
  it('are named, never placed: no folder, plain characters, the right extension', () => {
    expect(screenshotName('/data/projects/acme/shots/BILL-123-AC1.png', undefined)).toBe('BILL-123-AC1.png');
    expect(screenshotName('..\\evil\\name with spaces.jpg', 'jpeg')).toBe('name-with-spaces.jpeg');
    expect(screenshotName('', 'png', 42)).toBe('screenshot-42.png');
  });

  it('are taken in the browser’s own folder and kept with the run’s files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shot-'));
    const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-evidence-'));
    const { child, calls } = fakeBrowser((name, args) => {
      if (name === 'browser_take_screenshot') {
        fs.writeFileSync(String(args.filename), PAGE_PNG);
        return { content: [{ type: 'text', text: `### Result\nTook the screenshot and saved it as ${String(args.filename)}` }, { type: 'image', data: 'aW1n', mimeType: 'image/png' }] };
      }
      return page('https://staging.billing.acme.dev/home');
    });
    const s = new TestSystemsSession({ systems: () => [billing], secret: (n) => SECRETS[n], startBrowser: async () => child, tempDir: () => tmp, sleep: async () => {}, filesDir: files });
    const res = await s.call('browser_take_screenshot', { filename: '/data/projects/acme/shots/BILL-123-AC1.png' });
    expect(calls[0].args.filename).toBe(path.join(tmp, 'BILL-123-AC1.png'));
    expect(fs.readFileSync(path.join(files, 'BILL-123-AC1.png')).equals(PAGE_PNG)).toBe(true);
    expect(JSON.stringify(res)).toContain('with this run’s files');
    // Never the browser's own folder: a later step would go looking for it.
    expect(JSON.stringify(res)).not.toContain(tmp);
    expect(JSON.stringify(res)).toContain('in this step only');
    // The kept copy's path, for a tool that attaches it to a ticket.
    expect(JSON.stringify(res)).toContain(path.join(files, 'BILL-123-AC1.png'));
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    await s.call('browser_take_screenshot', { filename: 'BILL-123-AC1.png' });
    expect(fs.existsSync(path.join(files, 'BILL-123-AC1-2.png'))).toBe(true);
    await s.call('browser_snapshot', { filename: '/etc/x.md' });
    expect(calls[2].args).not.toHaveProperty('filename');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
  });

  // Playwright sends no picture back when it's given a file name, as here.
  function shooter(sizes: number[]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-shot-'));
    let n = 0;
    const slept: number[] = [];
    const { child, calls } = fakeBrowser((name, args) => {
      if (name === 'browser_take_screenshot') {
        fs.writeFileSync(String(args.filename), Buffer.alloc(sizes[Math.min(n++, sizes.length - 1)], 3));
        return { content: [{ type: 'text', text: `### Result\nSaved it as ${String(args.filename)}` }] };
      }
      return page('https://staging.billing.acme.dev/home');
    });
    const s = new TestSystemsSession({ systems: () => [billing], secret: (n) => SECRETS[n], startBrowser: async () => child, tempDir: () => tmp, sleep: async (ms) => void slept.push(ms) });
    const shots = () => calls.filter((c) => c.name === 'browser_take_screenshot').length;
    return { s, shots, slept, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }
  const said = (res: ToolResult) => res.content.map((c) => c.text ?? '').join(' ');

  it('are sent back for the worker to see, from the file', async () => {
    const t = shooter([PAGE_PNG.length]);
    const res = await t.s.call('browser_take_screenshot', {});
    const img = res.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ mimeType: 'image/png', data: PAGE_PNG.toString('base64') });
    expect(said(res)).toContain('shown below');
    expect(t.shots()).toBe(1);
    t.done();
  });

  it('are not sent back when too large to show, and say so', async () => {
    const t = shooter([MAX_INLINE_IMAGE_BYTES + 1]);
    const res = await t.s.call('browser_take_screenshot', {});
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toContain('too large to show');
    t.done();
  });

  it('are taken again, after a moment, when they come out almost empty', async () => {
    const t = shooter([LIKELY_BLANK_BYTES - 1, PAGE_PNG.length]);
    const res = await t.s.call('browser_take_screenshot', { fullPage: true });
    expect(t.shots()).toBe(2);
    expect(t.slept).toEqual([BLANK_RETRY_MS]);
    expect(said(res)).not.toContain('almost empty');
    expect(res.content.find((c) => c.type === 'image')?.data).toBe(PAGE_PNG.toString('base64'));
    t.done();
  });

  it('warn the worker off one that stays almost empty, without trying forever', async () => {
    const t = shooter([LIKELY_BLANK_BYTES - 1]);
    const res = await t.s.call('browser_take_screenshot', {});
    expect(t.shots()).toBe(2);
    expect(said(res)).toContain('almost empty');
    expect(said(res)).toContain('Don’t use it as evidence');
    t.done();
  });
});
