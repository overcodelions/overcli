import { describe, expect, it } from 'vitest';
import { UpdateCheck, isNewer } from './updateCheck';

const github = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('the update check', () => {
  it('compares plain releases only', () => {
    expect(isNewer('0.23.0', '0.22.4')).toBe(true);
    expect(isNewer('v0.22.10', '0.22.9')).toBe(true);
    expect(isNewer('0.22.0', '0.22.0')).toBe(false);
    expect(isNewer('0.21.9', '0.22.0')).toBe(false);
    expect(isNewer('0.23.0-beta.1', '0.22.0')).toBe(false);
  });

  it('says what runs here, and what is newer with where to read about it', async () => {
    const u = new UpdateCheck({ current: '0.22.0', enabled: () => true, fetchImpl: github({ tag_name: 'v0.23.0', html_url: 'https://github.com/overcodelions/overcli/releases/tag/v0.23.0' }) });
    expect(u.health()).toEqual({ name: 'Version', ok: true, detail: 'overcli 0.22.0.' });
    await u.check();
    expect(u.health().ok).toBeNull();
    expect(u.health().detail).toContain('0.23.0 is out: what’s new at https://github.com/overcodelions/overcli/releases/tag/v0.23.0'.replace('’', "'"));
  });

  it('stays quiet on a pre-release, says when GitHub could not be reached, and can be off', async () => {
    const pre = new UpdateCheck({ current: '0.22.0', enabled: () => true, fetchImpl: github({ tag_name: 'v0.23.0-rc.1', prerelease: true }) });
    await pre.check();
    expect(pre.health().ok).toBe(true);
    const down = new UpdateCheck({ current: '0.22.0', enabled: () => true, fetchImpl: github({}, 503) });
    await down.check();
    expect(down.health().detail).toContain('Couldn’t reach GitHub'.replace('’', "'"));
    let asked = 0;
    const off = new UpdateCheck({ current: '0.22.0', enabled: () => false, fetchImpl: async () => (asked++, new Response('{}')) });
    await off.check();
    expect(asked).toBe(0);
    expect(off.health().detail).toContain('OVERCLI_UPDATE_CHECK=0');
  });
});
