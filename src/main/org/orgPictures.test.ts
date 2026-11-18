import { describe, expect, it, vi } from 'vitest';
import { defaultWorkerPicture } from '../../shared/flows/avatars';
import { clearOrgPictures, orgPicture, pictureAllowed } from './orgPictures';

describe('pictureAllowed', () => {
  it('takes the picture services the server uses, and nothing else', () => {
    expect(pictureAllowed(defaultWorkerPicture('seed-1'))).toBe(true);
    expect(pictureAllowed('https://api.dicebear.com/9.x/pixel-art/svg?seed=x')).toBe(true);
    expect(pictureAllowed('https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Robot/Flat/robot_flat.svg')).toBe(true);
    for (const bad of [
      'http://api.dicebear.com/9.x/pixel-art/svg',
      'https://api.dicebear.com.evil.example/9.x/a/svg',
      'https://user:pw@api.dicebear.com/9.x/a/svg',
      'https://api.dicebear.com:8443/9.x/a/svg',
      'https://raw.githubusercontent.com/someone/else/main/a.svg',
      'https://intranet.acme.example/admin',
      'file:///etc/passwd',
      'not a url',
    ]) expect(pictureAllowed(bad), bad).toBe(false);
  });
});

describe('orgPicture', () => {
  const url = 'https://api.dicebear.com/9.x/pixel-art/svg?seed=t1';
  const reply = (body: string, type: string, status = 200) => new Response(body, { status, headers: { 'content-type': type } });

  it('hands back a data URL, asks once, and follows no redirect', async () => {
    const f = vi.fn(async () => reply('<svg/>', 'image/svg+xml; charset=utf-8'));
    expect(await orgPicture(url, f as unknown as typeof fetch)).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
    expect(await orgPicture(url, f as unknown as typeof fetch)).toMatch(/^data:image\/svg\+xml/);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses what is not a picture, too big, or not from those services', async () => {
    const page = vi.fn(async () => reply('<html/>', 'text/html'));
    expect(await orgPicture('https://api.dicebear.com/9.x/pixel-art/svg?seed=t2', page as unknown as typeof fetch)).toBeNull();
    const big = vi.fn(async () => reply('x'.repeat(600 * 1024), 'image/png'));
    expect(await orgPicture('https://api.dicebear.com/9.x/pixel-art/svg?seed=t3', big as unknown as typeof fetch)).toBeNull();
    const never = vi.fn();
    expect(await orgPicture('https://intranet.acme.example/a.png', never as unknown as typeof fetch)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('asks again after a failure that may pass, but not after one that won’t', async () => {
    clearOrgPictures();
    let t = 1_000;
    const clock = () => t;
    const flaky = 'https://api.dicebear.com/9.x/pixel-art/svg?seed=t4';
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await orgPicture(flaky, down as unknown as typeof fetch, clock)).toBeNull();
    const busy = vi.fn(async () => reply('busy', 'text/plain', 503));
    expect(await orgPicture(flaky, busy as unknown as typeof fetch, clock)).toBeNull();
    expect(busy).not.toHaveBeenCalled();
    t += 61_000;
    expect(await orgPicture(flaky, busy as unknown as typeof fetch, clock)).toBeNull();
    expect(busy).toHaveBeenCalledTimes(1);
    t += 61_000;
    const back = vi.fn(async () => reply('<svg/>', 'image/svg+xml'));
    expect(await orgPicture(flaky, back as unknown as typeof fetch, clock)).toMatch(/^data:image\/svg\+xml/);

    const gone = 'https://api.dicebear.com/9.x/pixel-art/svg?seed=t5';
    const missing = vi.fn(async () => reply('no', 'text/plain', 404));
    expect(await orgPicture(gone, missing as unknown as typeof fetch, clock)).toBeNull();
    t += 10 * 61_000;
    expect(await orgPicture(gone, missing as unknown as typeof fetch, clock)).toBeNull();
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('asks once for the same picture wanted twice at once, and stops reading past the size cap', async () => {
    clearOrgPictures();
    const u = 'https://api.dicebear.com/9.x/pixel-art/svg?seed=t6';
    const f = vi.fn(async () => reply('<svg/>', 'image/svg+xml'));
    const [a, b] = await Promise.all([orgPicture(u, f as unknown as typeof fetch), orgPicture(u, f as unknown as typeof fetch)]);
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
    // No length header: the cap is enforced while reading.
    const chunked = vi.fn(async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(100 * 1024)); c.close(); } }), { headers: { 'content-type': 'image/png' } }));
    expect(await orgPicture('https://api.dicebear.com/9.x/pixel-art/png?seed=t7', chunked as unknown as typeof fetch)).toBeNull();
  });
});
