import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLAYWRIGHT_FOR_MCP, PLAYWRIGHT_MCP, VENDORED_PLAYWRIGHT_MCP, playwrightArgs, playwrightCommand } from './testSystemsServer';
import { NO_BROWSER, browserMissing } from './testSystemsSession';

describe('the browser behind apps to test', () => {
  it('starts Playwright’s own Chromium, never Google Chrome, without the sandbox on Linux', () => {
    const linux = playwrightArgs('/tmp/out', 'linux');
    expect(linux.slice(linux.indexOf('--browser'), linux.indexOf('--browser') + 2)).toEqual(['--browser', 'chromium']);
    expect(linux).toContain('--no-sandbox');
    expect(playwrightArgs('/tmp/out', 'darwin')).not.toContain('--no-sandbox');
    expect(linux).toEqual(expect.arrayContaining(['--headless', '--isolated', '--caps=storage,testing', '--output-dir', '/tmp/out']));
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

  it('knows when Playwright has no browser, and says what to do', () => {
    expect(browserMissing('### Error\nError: async initializeServer: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"')).toBe(true);
    expect(browserMissing("Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome")).toBe(true);
    expect(browserMissing('Timeout 5000ms exceeded.')).toBe(false);
    expect(NO_BROWSER).toContain('npx playwright install --with-deps chromium');
  });
});
