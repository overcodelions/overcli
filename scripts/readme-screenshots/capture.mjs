// Regenerates the README screenshots in docs/screenshots/.
//
// Runs the built app against a throwaway HOME (fictional acme-* repos and
// Claude transcripts, see seed.mjs) and its own `readme-shots` profile, so
// nothing from your real projects can end up in an image. Every backend is
// faked as ready via OVERCLI_FAKE_HEALTH; no CLI is ever called.
//
//   npm run build
//   npm i --no-save playwright-core
//   node scripts/readme-screenshots/capture.mjs
//
// Framing needs Python 3 with Pillow (`pip3 install pillow`).

import { _electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..', '..');
const work = path.join(fs.realpathSync(os.tmpdir()), 'overcli-readme-shots');
const raw = path.join(work, 'raw');
const PROFILE = 'readme-shots';

async function launch(home) {
  const app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules', '.bin', 'electron'),
    args: ['.', '--force-device-scale-factor=2'],
    cwd: repo,
    env: { ...process.env, HOME: home, OVERCLI_PROFILE: PROFILE, OVERCLI_FAKE_HEALTH: 'ready' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.center();
  });
  await page.waitForTimeout(2500);
  return { app, page };
}

// Rewrites the sandbox HOME to `~` in the DOM and drops hover titles, so
// no temp path shows up in a header or tooltip.
const tidy = (page, home) =>
  page.evaluate((home) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) if (n.nodeValue.includes(home)) n.nodeValue = n.nodeValue.split(home).join('~');
    document.querySelectorAll('[title]').forEach((e) => (e.title = ''));
  }, home);

async function session(theme, scenes) {
  const ids = await seed(theme);
  const { app, page } = await launch(ids.home);
  try {
    const shot = async (name, wait = 1500) => {
      await page.waitForTimeout(wait);
      await tidy(page, ids.home);
      await page.screenshot({ path: path.join(raw, `${name}.png`) });
      console.log('  ', name);
    };
    await scenes(page, shot);
  } finally {
    await app.close();
  }
}

let userData;
async function seed(theme) {
  if (!userData) {
    // Ask Electron where the profile lives rather than guessing per platform
    // (devProfile.ts puts it at <appData>/Overcli-<profile>). A two-line main
    // script, not the app: starting the app against an unseeded profile would
    // run its CLI updaters on this machine.
    const probe = path.join(work, 'where.cjs');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(probe, "const { app } = require('electron');\nprocess.stdout.write(app.getPath('appData'));\napp.exit(0);\n");
    const appData = execFileSync(path.join(repo, 'node_modules', '.bin', 'electron'), [probe], { encoding: 'utf8' }).trim();
    userData = path.join(appData, `Overcli-${PROFILE}`);
  }
  execFileSync('node', [path.join(here, 'seed.mjs'), work, userData, theme], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(path.join(work, 'seed-ids.json'), 'utf8'));
}

const esc = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};

fs.rmSync(raw, { recursive: true, force: true });
fs.mkdirSync(raw, { recursive: true });

console.log('dark');
await session('dark', async (page, shot) => {
  await shot('chat', 2500);
  await page.getByRole('button', { name: 'Diff', exact: true }).first().click();
  await shot('diff');
  await esc(page);
  await page.getByText('rebound', { exact: true }).first().click();
  await shot('rebound');
  await esc(page);
  await page.getByRole('button', { name: 'Usage' }).first().click();
  await shot('usage', 2500);
  await page.getByText('Chat', { exact: true }).first().click();
  await page.getByText('Extensions', { exact: true }).first().click();
  await shot('extensions');
  await esc(page);
  await page.keyboard.press('Meta+,');
  await page.waitForTimeout(800);
  await page.getByText('Backends', { exact: true }).first().click();
  await shot('backends');
  await esc(page);
  await page.getByText('Workers', { exact: true }).first().click();
  await shot('workers');
  await page.getByText('Flows', { exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.getByText('Solve a ticket', { exact: true }).first().click();
  await shot('flow');
});

console.log('light');
await session('light', async (page, shot) => {
  await page.getByText(/Show \d+ steps/).first().click();
  await page.waitForTimeout(800);
  // The transcript is virtualised; nudge every big scroller to the top until the prompt is in.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((el) => {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50 && el.clientWidth > 900) el.scrollTop = 0;
      }),
    );
    await page.waitForTimeout(500);
  }
  await page.getByText('Thinking', { exact: false }).first().click();
  await shot('tools-light', 600);
});

// ---- overgo console ------------------------------------------------------
//
// `overcli serve` against a fictional Acme state directory (seed-overgo.mjs),
// in a sandbox HOME, with an environment built from nothing: no API keys, and
// a PATH with no model CLI on it, so no worker can run. The console is opened
// in a bare Electron window signed in with a token minted for the sandbox.

async function overgo(scenes) {
  const sandbox = path.join(work, 'overgo');
  const home = path.join(sandbox, 'home');
  const state = path.join(home, '.overcli');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  execFileSync('node', [path.join(here, 'seed-overgo.mjs'), state], { stdio: 'inherit' });
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    OVERCLI_HOME: state,
    // Keeps the secrets key out of the login keychain.
    OVERCLI_SECRETS_KEY: 'readme-screenshots',
    TZ: 'America/New_York',
  };
  const cli = path.join(repo, 'dist', 'cli', 'index.js');
  const token = execFileSync(process.execPath, [cli, 'tokens', 'create', '--name', 'Dana Reyes', '--slack', 'U0ACMEDR1', '--admin'], { env, encoding: 'utf8' })
    .split('\n')[0]
    .trim();
  const port = 7400 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [cli, 'serve', '--control', `127.0.0.1:${port}`], { env, cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60 && !log.includes('control: http'); i++) await new Promise((r) => setTimeout(r, 250));
  if (!log.includes('control: http')) throw new Error(`overcli serve did not start:\n${log}`);

  const browser = path.join(sandbox, 'browser.cjs');
  fs.writeFileSync(
    browser,
    "const { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => new BrowserWindow({ width: 1600, height: 1000 }).loadURL(process.env.CONSOLE_URL));\n",
  );
  const app = await _electron.launch({
    executablePath: path.join(repo, 'node_modules', '.bin', 'electron'),
    args: [browser, '--force-device-scale-factor=2', `--user-data-dir=${path.join(sandbox, 'browser-profile')}`],
    env: { ...process.env, HOME: home, CONSOLE_URL: base },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    await page.waitForLoadState();
    await page.evaluate((t) => localStorage.setItem('overcli-org-token', t), token);
    const open = async (hash, theme) => {
      await page.evaluate((t) => localStorage.setItem('overcli-org-theme', t), theme);
      await page.goto(base + '#' + hash);
      await page.reload();
      await page.waitForTimeout(2500);
    };
    const shot = async (name) => {
      await tidy(page, state);
      await page.screenshot({ path: path.join(raw, `${name}.png`) });
      console.log('  ', name);
    };
    await scenes({ page, open, shot, ids: JSON.parse(fs.readFileSync(path.join(state, 'seed-overgo.json'), 'utf8')) });
  } finally {
    await app.close();
    server.kill('SIGTERM');
  }
}

console.log('overgo');
await overgo(async ({ open, shot }) => {
  await open('today', 'light');
  await shot('overgo-inbox');
  await open('workers', 'dark');
  await shot('overgo-workers');
  await open('reports', 'dark');
  await shot('overgo-reports');
});

execFileSync('python3', [path.join(here, 'frame.py'), raw, path.join(repo, 'docs', 'screenshots')], { stdio: 'inherit' });
fs.rmSync(userData, { recursive: true, force: true });
