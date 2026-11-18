import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLAYWRIGHT_FOR_MCP, PLAYWRIGHT_MCP, VENDORED_PLAYWRIGHT_MCP, lockedPlaywright, lockfileDirs, playwrightArgs, playwrightCommand } from './testSystemsServer';
import { NO_BROWSER, browserMissing } from './testSystemsSession';

describe('the browser behind apps to test', () => {
  it('starts Playwright’s own Chromium, never Google Chrome, without the sandbox on Linux', () => {
    const linux = playwrightArgs('/tmp/out', 'linux');
    expect(linux.slice(linux.indexOf('--browser'), linux.indexOf('--browser') + 2)).toEqual(['--browser', 'chromium']);
    expect(linux).toContain('--no-sandbox');
    expect(playwrightArgs('/tmp/out', 'darwin')).not.toContain('--no-sandbox');
    expect(linux).toEqual(expect.arrayContaining(['--headless', '--isolated', '--caps=storage,testing,devtools', '--output-dir', '/tmp/out']));
    expect(linux).not.toContain('-y');
  });

  it('is the version the image vendors, with its lockfile, and the Chromium it installs', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const dockerfile = fs.readFileSync(path.join(root, 'deploy', 'Dockerfile'), 'utf-8');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'playwright-mcp', 'package-lock.json'), 'utf-8')) as { packages: Record<string, { version?: string; integrity?: string }> };
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'playwright-mcp', 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
    const pinned = PLAYWRIGHT_MCP.slice(PLAYWRIGHT_MCP.lastIndexOf('@') + 1);
    expect(pkg.dependencies['@playwright/mcp']).toBe(pinned);
    expect(lock.packages['node_modules/@playwright/mcp'].version).toBe(pinned);
    expect(lock.packages['node_modules/playwright'].version).toBe(PLAYWRIGHT_FOR_MCP);
    for (const [name, p] of Object.entries(lock.packages)) if (name) expect(p.integrity, name).toMatch(/^sha512-/);
    // Installed from the lockfile, and Chromium by the vendored Playwright itself.
    expect(dockerfile).toContain('COPY deploy/playwright-mcp/package.json deploy/playwright-mcp/package-lock.json ./');
    expect(dockerfile).toMatch(/npm ci\b/);
    expect(dockerfile).toContain('/opt/playwright-mcp/node_modules/playwright/cli.js install --with-deps chromium');
    expect(dockerfile).not.toMatch(/npx -y "?playwright/);
    expect(VENDORED_PLAYWRIGHT_MCP.startsWith('/opt/playwright-mcp/')).toBe(true);
  });

  it('runs the vendored copy when there is one, and never a package spec from the environment', () => {
    const all = () => true;
    const none = () => false;
    expect(playwrightCommand('/o', { exists: all, node: '/usr/local/bin/node', platform: 'linux' })).toEqual({ command: '/usr/local/bin/node', args: [VENDORED_PLAYWRIGHT_MCP, ...playwrightArgs('/o', 'linux')] });
    // The vendored copy wins over the override.
    expect(playwrightCommand('/o', { exists: all, node: 'node', env: { OVERCLI_PLAYWRIGHT_MCP: '/home/me/mcp/cli.js' } }).args[0]).toBe(VENDORED_PLAYWRIGHT_MCP);
    // No vendored copy: npx at the pinned version.
    expect(playwrightCommand('/o', { exists: none, platform: 'darwin' })).toEqual({ command: 'npx', args: ['-y', PLAYWRIGHT_MCP, ...playwrightArgs('/o', 'darwin')] });
    // An override is a local cli.js that exists, or nothing.
    const only = (f: string) => f === '/home/me/mcp/cli.js';
    const local = playwrightCommand('/o', { exists: only, node: 'node', env: { OVERCLI_PLAYWRIGHT_MCP: '/home/me/mcp/cli.js' } });
    expect([local.command, local.args[0]]).toEqual(['node', '/home/me/mcp/cli.js']);
    for (const spec of ['@evil/mcp@latest', 'https://evil.example/x.tgz', 'relative/cli.js', '/home/me/missing/cli.js', '/bin/sh']) {
      const c = playwrightCommand('/o', { exists: only, env: { OVERCLI_PLAYWRIGHT_MCP: spec } });
      expect([c.command, ...c.args.slice(0, 2)], spec).toEqual(['npx', '-y', PLAYWRIGHT_MCP]);
    }
  });

  it('sends every request through its proxy, loopback included', () => {
    const args = playwrightArgs('/o', 'linux', 'http://127.0.0.1:40123');
    expect(args.slice(args.indexOf('--proxy-server'), args.indexOf('--proxy-server') + 4)).toEqual(['--proxy-server', 'http://127.0.0.1:40123', '--proxy-bypass', '<-loopback>']);
    expect(playwrightArgs('/o', 'linux')).not.toContain('--proxy-server');
    expect(playwrightCommand('/o', { exists: () => true, node: 'node', proxy: 'http://127.0.0.1:1' }).args).toContain('--proxy-server');
  });

  it('outside the image, runs the copy installed from the lockfile, not npx', () => {
    const none = () => false;
    expect(playwrightCommand('/o', { exists: none, node: 'node', platform: 'darwin', locked: '/home/me/.overcli/playwright-mcp/abc/node_modules/@playwright/mcp/cli.js' })).toEqual({
      command: 'node',
      args: ['/home/me/.overcli/playwright-mcp/abc/node_modules/@playwright/mcp/cli.js', ...playwrightArgs('/o', 'darwin')],
    });
    // A local override still wins over it, and the vendored copy over both.
    const only = (f: string) => f === '/home/me/mcp/cli.js';
    expect(playwrightCommand('/o', { exists: only, node: 'node', env: { OVERCLI_PLAYWRIGHT_MCP: '/home/me/mcp/cli.js' }, locked: '/x/cli.js' }).args[0]).toBe('/home/me/mcp/cli.js');
    expect(playwrightCommand('/o', { exists: () => true, node: 'node', locked: '/x/cli.js' }).args[0]).toBe(VENDORED_PLAYWRIGHT_MCP);
  });

  it('installs from the lockfile once, with npm ci, and finds it in a checkout and a packaged app', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lock-'));
    try {
      const src = path.join(home, 'src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'package.json'), '{"dependencies":{"@playwright/mcp":"0.0.84"}}');
      fs.writeFileSync(path.join(src, 'package-lock.json'), '{"lockfileVersion":3}');
      const ran: string[] = [];
      const ci = async (dir: string) => {
        ran.push(dir);
        expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf-8')).toBe('{"lockfileVersion":3}');
        fs.mkdirSync(path.join(dir, 'node_modules', '@playwright', 'mcp'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js'), '');
      };
      const cli = await lockedPlaywright({ dirs: [path.join(home, 'missing'), src], home, ci });
      expect(cli).toMatch(/\.overcli\/playwright-mcp\/[0-9a-f]{16}\/node_modules\/@playwright\/mcp\/cli\.js$/);
      expect(await lockedPlaywright({ dirs: [src], home, ci })).toBe(cli);
      expect(ran).toHaveLength(1);
      expect(await lockedPlaywright({ dirs: [path.join(home, 'missing')], home, ci })).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    // The checkout's own, and the packaged app's resources copy.
    const root = path.join(__dirname, '..', '..', '..');
    expect(lockfileDirs(path.join(root, 'dist', 'main', 'org'))[0]).toBe(path.join(root, 'deploy', 'playwright-mcp'));
    expect(lockfileDirs('/Applications/Overcli.app/Contents/Resources/app.asar/dist/main/org')[1]).toBe('/Applications/Overcli.app/Contents/Resources/playwright-mcp');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { build: { extraResources: Array<{ from: string; to: string; filter: string[] }> } };
    expect(pkg.build.extraResources).toContainEqual({ from: 'deploy/playwright-mcp', to: 'playwright-mcp', filter: ['package.json', 'package-lock.json'] });
  });

  it('knows when Playwright has no browser, and says what to do', () => {
    expect(browserMissing('### Error\nError: async initializeServer: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"')).toBe(true);
    expect(browserMissing("Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome")).toBe(true);
    expect(browserMissing('Timeout 5000ms exceeded.')).toBe(false);
    expect(NO_BROWSER).toContain('npx playwright install --with-deps chromium');
  });
});
