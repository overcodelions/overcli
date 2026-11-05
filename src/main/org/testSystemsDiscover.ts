// Setup → Apps to test's Discover: from an app's address, what the form
// would otherwise ask for. The server opens the address in the same headless
// browser the test-systems tool drives, finds the login form (following a
// "Sign in" link, and a Next button to a second screen), and reads the
// fields; it tries the usual health check paths. What it finds fills the
// form for an admin to check: nothing is saved, and no password is typed.

import type { ExtraField, TestSignIn } from '../../shared/testSystems';

/// What the page scan reports for one screen.
export interface ScreenScan {
  url: string;
  title?: string;
  user: string | null;
  password: string | null;
  submit: string | null;
  submitText?: string | null;
  code: string | null;
  extras: Array<{ label: string; selector: string; action: 'fill' | 'select' | 'check'; options?: string[]; secret?: boolean }>;
}

export interface DiscoveredExtra extends Omit<ExtraField, 'key'> {
  /// A drop-down's options, to pick from.
  options?: string[];
}

/// A sign-in as discovered: extra fields not yet keyed (saving keys them).
export type DiscoveredSignIn = Exclude<TestSignIn, { kind: 'form' }> | (Omit<Extract<TestSignIn, { kind: 'form' }>, 'extra'> & { extra?: DiscoveredExtra[] });

export interface Discovered {
  name: string;
  url: string;
  healthPath?: string;
  signIn: DiscoveredSignIn;
  /// Sign-in left for another site (an identity provider): its host.
  sso?: string;
  /// What it found, and what to check, one plain line each.
  found: string[];
  warnings: string[];
}

export const HEALTH_PATHS = ['/health', '/healthz', '/api/health', '/status', '/ping'];

const GENERIC = new Set(['www', 'app', 'apps', 'staging', 'stage', 'stg', 'dev', 'develop', 'qa', 'test', 'testing', 'uat', 'preview', 'feature', 'local', 'localhost', 'admin', 'portal', 'web']);

/// A name from the host: the first label that says something
/// (staging.billing.acme.dev → Billing), else the host's first label.
export function nameFromHost(host: string): string {
  const labels = host.split(':')[0].split('.').filter(Boolean);
  if (labels.every((l) => /^\d+$/.test(l))) return 'App';
  const pick = labels.slice(0, Math.max(1, labels.length - 2)).find((l) => !GENERIC.has(l.toLowerCase())) ?? labels[0] ?? 'App';
  const words = pick.split('-').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ') || 'App';
}

/// The scan, run in the page: the visible login fields, each with a
/// selector Playwright can find again. Plain browser JavaScript.
export const SCAN_PAGE = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const uniq = (q) => { try { return document.querySelectorAll(q).length === 1; } catch (e) { return false; } };
  const sel = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && uniq('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['name', 'data-testid', 'data-test', 'autocomplete', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && v.indexOf('"') < 0) { const q = tag + '[' + a + '="' + v + '"]'; if (uniq(q)) return q; }
    }
    if (tag === 'input' && el.type) { const q = 'input[type="' + el.type + '"]'; if (uniq(q)) return q; }
    const text = ((el.innerText || el.value || '') + '').trim().split('"').join('');
    if ((tag === 'button' || el.type === 'submit') && text) return tag + ':has-text("' + text.slice(0, 40) + '")';
    return tag + ' >> nth=' + Array.prototype.indexOf.call(document.querySelectorAll(tag), el);
  };
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + esc(el.id) + '"]'); if (l && l.innerText.trim()) return l.innerText.trim(); }
    const p = el.closest('label'); if (p && p.innerText.trim()) return p.innerText.trim();
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
  };
  const skip = ['hidden', 'submit', 'button', 'image', 'reset', 'file'];
  const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => vis(el) && skip.indexOf((el.type || '').toLowerCase()) < 0);
  const words = (el) => [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), labelOf(el), el.type].join(' ').toLowerCase();
  const pw = inputs.find((el) => el.type === 'password');
  const isCode = (el) => el !== pw && (el.getAttribute('autocomplete') === 'one-time-code' || ['otp', 'one-time', 'totp', 'mfa', '2fa', 'verification', 'authenticator'].some((w) => words(el).indexOf(w) >= 0));
  const textish = (el) => el.tagName === 'INPUT' && ['text', 'email', 'tel', ''].indexOf((el.type || '').toLowerCase()) >= 0;
  const userEl = inputs.find((el) => el !== pw && !isCode(el) && textish(el) && (el.type === 'email' || ['user', 'email', 'login', 'account'].some((w) => words(el).indexOf(w) >= 0))) || inputs.find((el) => el !== pw && !isCode(el) && textish(el));
  const anchor = pw || userEl;
  const form = anchor ? anchor.closest('form') : null;
  const scope = form || document;
  const buttons = Array.from(scope.querySelectorAll('button, input[type=submit], [role=button]')).filter(vis);
  const label = (b) => ((b.innerText || b.value || '') + '').trim();
  const submitEl = buttons.find((b) => (b.type || '').toLowerCase() === 'submit') || buttons.find((b) => ['sign in', 'log in', 'login', 'continue', 'next', 'submit'].some((w) => label(b).toLowerCase().indexOf(w) >= 0));
  const codeEl = inputs.find(isCode);
  const extras = inputs
    .filter((el) => el !== pw && el !== userEl && el !== codeEl && (!form || el.closest('form') === form) && words(el).indexOf('search') < 0)
    .slice(0, 6)
    .map((el) => ({
      label: labelOf(el).slice(0, 40),
      selector: sel(el),
      action: el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' ? 'check' : 'fill',
      options: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.value).filter(Boolean).slice(0, 8) : undefined,
      secret: ['pin', 'secret', 'passcode'].some((w) => words(el).indexOf(w) >= 0) || undefined,
    }));
  return { url: location.href, title: document.title, user: userEl ? sel(userEl) : null, password: pw ? sel(pw) : null, submit: submitEl ? sel(submitEl) : null, submitText: submitEl ? label(submitEl).slice(0, 40) : null, code: codeEl ? sel(codeEl) : null, extras: extras };
}`;

/// Playwright code: open the address, follow a sign-in link if the page has
/// no form, and press Next past a username-only screen with `username`.
export function discoverScript(start: string, username: string): string {
  const q = JSON.stringify;
  return [
    'async (page) => {',
    `  const scan = ${SCAN_PAGE};`,
    `  await page.goto(${q(start)}, { waitUntil: 'domcontentloaded', timeout: 30000 });`,
    "  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});",
    '  let first = await page.evaluate(scan);',
    '  if (!first.password && !first.user) {',
    "    const go = page.getByRole('link', { name: /sign in|log in|login/i }).or(page.getByRole('button', { name: /sign in|log in|login/i })).first();",
    '    if (await go.count()) {',
    "      await Promise.all([page.waitForLoadState('load').catch(() => {}), go.click()]);",
    "      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});",
    '      first = await page.evaluate(scan);',
    '    }',
    '  }',
    '  let second = null;',
    '  if (first.user && !first.password && first.submit) {',
    `    await page.locator(first.user).first().fill(${q(username)});`,
    "    await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator(first.submit).first().click()]);",
    '    await page.waitForTimeout(1500);',
    "    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});",
    '    second = await page.evaluate(scan);',
    '  }',
    '  return JSON.stringify({ first, second });',
    '}',
  ].join('\n');
}

const pathOf = (u: URL): string => u.pathname || '/';

/// What the scans say, as the form's settings.
export function planFromScan(address: string, scans: { first: ScreenScan; second: ScreenScan | null }, healthPath?: string): Discovered {
  const start = new URL(address);
  const app = start.origin;
  const found: string[] = [];
  const warnings: string[] = [];
  const out: Discovered = { name: nameFromHost(start.host), url: app, ...(healthPath ? { healthPath } : {}), signIn: { kind: 'none' }, found, warnings };
  if (healthPath) found.push(`A health check at ${healthPath}.`);
  else warnings.push('No health check answered at the usual paths. Add one if feature environments take a while to deploy.');

  const { first, second } = scans;
  const firstUrl = new URL(first.url);
  const away = [first, second].map((s) => (s ? new URL(s.url) : null)).find((u) => u && u.origin !== app);
  if (away) {
    out.sso = away.host;
    warnings.push(`Signing in goes to ${away.host}, another site. A login page there may ask for MFA; a test login endpoint on the app is more reliable.`);
  }

  const extras = (s: ScreenScan): DiscoveredExtra[] =>
    s.extras.map((e) => ({
      label: e.label ? e.label.charAt(0).toUpperCase() + e.label.slice(1) : e.action === 'check' ? 'Checkbox' : 'Field',
      selector: e.selector,
      action: e.action,
      ...(e.options?.length ? { options: e.options } : {}),
      ...(e.secret ? { secret: true } : {}),
    }));

  if (first.user && first.password && first.submit) {
    out.signIn = {
      kind: 'form',
      loginPath: firstUrl.origin === app ? pathOf(firstUrl) : '/',
      userField: first.user,
      passwordField: first.password,
      submit: first.submit,
      ...(first.code ? { codeField: first.code } : {}),
      ...(first.extras.length ? { extra: extras(first) } : {}),
    };
    found.push(`A login page at ${pathOf(firstUrl)} with a username field (${first.user}), a password field (${first.password}) and a sign-in button (${first.submit}).`);
  } else if (first.user && first.submit && second?.password) {
    out.signIn = {
      kind: 'form',
      loginPath: firstUrl.origin === app ? pathOf(firstUrl) : '/',
      userField: first.user,
      nextButton: first.submit,
      passwordField: second.password,
      submit: second.submit ?? first.submit,
      ...(second.code || first.code ? { codeField: (second.code ?? first.code) as string } : {}),
      ...(first.extras.length ? { extra: extras(first) } : {}),
    };
    found.push(`A login over two screens: the username (${first.user}) and ${first.submitText ? `“${first.submitText}”` : 'a Next button'} (${first.submit}), then the password (${second.password}) and ${second.submit ? `a sign-in button (${second.submit})` : 'the same button'}.`);
  } else if (first.user || first.password) {
    warnings.push('It found part of a login form but not all of it. Fill in the missing fields from your browser’s inspector.');
    out.signIn = { kind: 'form', loginPath: pathOf(firstUrl), userField: first.user ?? '', passwordField: first.password ?? '', submit: first.submit ?? '' };
  } else if (!away) {
    warnings.push(`No login form at ${address}. If the app needs no sign-in, that’s right; otherwise open its sign-in page and discover from that address.`);
  }

  if (out.signIn.kind === 'form') {
    const s = out.signIn;
    if (s.codeField) found.push(`A code field (${s.codeField}): add the account’s authenticator secret, or the server can’t get past it.`);
    for (const e of s.extra ?? []) {
      const did = e.action === 'select' ? `a drop-down${e.options?.length ? ` (${e.options.slice(0, 4).join(', ')}${e.options.length > 4 ? ', …' : ''})` : ''}` : e.action === 'check' ? 'a checkbox, ticked' : e.secret ? 'a secret field' : 'a field';
      found.push(`${e.label}: ${did} (${e.selector}).`);
    }
    if ((s.extra ?? []).some((e) => e.action !== 'check')) warnings.push('Give each extra field its value, or remove the ones sign-in doesn’t need.');
  }
  return out;
}
