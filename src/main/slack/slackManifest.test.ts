import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { slackManifest, slackManifestForConsole } from './slackManifest';

describe('slackManifest', () => {
  it('is the same app as slack-app-manifest.yml', () => {
    const file = parse(fs.readFileSync(path.join(__dirname, 'slack-app-manifest.yml'), 'utf8'));
    expect(slackManifest()).toEqual(file);
  });

  it('links to Slack with the manifest filled in', () => {
    const { yaml, createUrl } = slackManifestForConsole();
    expect(parse(yaml)).toEqual(slackManifest());
    const url = new URL(createUrl);
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(JSON.parse(url.searchParams.get('manifest_json')!)).toEqual(slackManifest());
  });
});
