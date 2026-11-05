import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLAYWRIGHT_FOR_MCP, playwrightArgs } from './testSystemsServer';
import { NO_BROWSER, browserMissing } from './testSystemsSession';

describe('the browser behind apps to test', () => {
  it('starts Playwright’s own Chromium, never Google Chrome, without the sandbox on Linux', () => {
    const linux = playwrightArgs('/tmp/out', 'linux');
    expect(linux.slice(linux.indexOf('--browser'), linux.indexOf('--browser') + 2)).toEqual(['--browser', 'chromium']);
    expect(linux).toContain('--no-sandbox');
    expect(playwrightArgs('/tmp/out', 'darwin')).not.toContain('--no-sandbox');
    expect(linux).toEqual(expect.arrayContaining(['--headless', '--isolated', '--caps=storage,testing', '--output-dir', '/tmp/out']));
  });

  it('is the Chromium the Docker image installs', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'deploy', 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain(`ARG PLAYWRIGHT_VERSION=${PLAYWRIGHT_FOR_MCP}`);
    expect(dockerfile).toContain('install --with-deps chromium');
  });

  it('knows when Playwright has no browser, and says what to do', () => {
    expect(browserMissing('### Error\nError: async initializeServer: Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"')).toBe(true);
    expect(browserMissing("Executable doesn't exist at /ms-playwright/chromium-1200/chrome-linux/chrome")).toBe(true);
    expect(browserMissing('Timeout 5000ms exceeded.')).toBe(false);
    expect(NO_BROWSER).toContain('npx playwright install --with-deps chromium');
  });
});
