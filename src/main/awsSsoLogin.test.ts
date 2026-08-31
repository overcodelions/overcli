// `aws sso login` is a long-lived child. Every terminal path (clean exit,
// non-zero exit, spawn error, timeout, and the one --no-browser retry) must
// settle the promise exactly once, or the IPC handler hangs forever.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { awsSsoLoginArgs, awsSsoLoginCommand, runAwsSsoLogin } from './awsSsoLogin';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  spawnMock.mockReturnValue(child);
  return child;
}

const login = (
  overrides: Partial<Parameters<typeof runAwsSsoLogin>[0]> = {},
) =>
  runAwsSsoLogin({
    binary: '/opt/homebrew/bin/aws',
    target: 'Zift',
    kind: 'profile',
    env: {},
    ...overrides,
  });

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe('awsSsoLoginArgs', () => {
  it('uses --profile for a profile and --sso-session for a session', () => {
    expect(awsSsoLoginArgs('Zift', 'profile', true)).toEqual([
      'sso', 'login', '--profile', 'Zift', '--no-browser',
    ]);
    expect(awsSsoLoginArgs('corp', 'sso-session', true)).toEqual([
      'sso', 'login', '--sso-session', 'corp', '--no-browser',
    ]);
  });

  it('omits --no-browser when not asked for', () => {
    expect(awsSsoLoginArgs('Zift', 'profile', false)).not.toContain('--no-browser');
  });
});

describe('awsSsoLoginCommand', () => {
  it('builds a shell line free of the metacharacters terminal.ts refuses', () => {
    const cmd = awsSsoLoginCommand('/opt/homebrew/bin/aws', 'Zift', 'profile');
    expect(cmd).toBe('/opt/homebrew/bin/aws sso login --profile "Zift"');
    expect(/[`$;&|<>\n\r]/.test(cmd)).toBe(false);
  });

  it('quotes a profile name containing a space, and stays shell-safe', () => {
    const cmd = awsSsoLoginCommand('/opt/homebrew/bin/aws', 'EU Prod', 'profile');
    expect(cmd).toBe('/opt/homebrew/bin/aws sso login --profile "EU Prod"');
    expect(/[`$;&|<>\n\r]/.test(cmd)).toBe(false);
  });

  it('quotes a binary path containing spaces', () => {
    expect(awsSsoLoginCommand('C:\\Program Files\\aws.exe', 'Zift', 'profile')).toContain(
      '"C:\\Program Files\\aws.exe"',
    );
  });
});

describe('runAwsSsoLogin', () => {
  it('passes --no-browser by default so only we open the browser', async () => {
    const child = fakeChild();
    const p = login();
    expect(spawnMock.mock.calls[0][0]).toBe('/opt/homebrew/bin/aws');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'sso', 'login', '--profile', 'Zift', '--no-browser',
    ]);
    child.emit('close', 0);
    await p;
  });

  it('refuses an unsafe target without spawning anything', async () => {
    const res = await login({ target: 'evil"; rm -rf /' });
    expect(res.ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('resolves ok with the collected output on exit 0', async () => {
    const child = fakeChild();
    const p = login();
    child.stdout.emit('data', Buffer.from('done\n'));
    child.emit('close', 0);
    await expect(p).resolves.toEqual({ ok: true, output: 'done\n' });
  });

  it('collects stderr into the same buffer', async () => {
    const child = fakeChild();
    const p = login();
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.emit('close', 0);
    expect((await p).output).toBe('warn\n');
  });

  it('reports the first URL exactly once', async () => {
    const child = fakeChild();
    const onUrl = vi.fn();
    const p = login({ onUrl });
    child.stdout.emit('data', Buffer.from('open https://oidc.us-east-1.amazonaws.com/authorize?a=1 now'));
    child.stdout.emit('data', Buffer.from('or https://second.example/y'));
    child.emit('close', 0);
    await p;
    expect(onUrl).toHaveBeenCalledTimes(1);
    expect(onUrl).toHaveBeenCalledWith('https://oidc.us-east-1.amazonaws.com/authorize?a=1');
  });

  it('surfaces the CLI\'s own error line rather than the bare exit code', async () => {
    const child = fakeChild();
    const p = login();
    child.stderr.emit('data', Buffer.from('Error loading SSO Token: expired\n'));
    child.emit('close', 255);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('expired');
  });

  it('falls back to the exit code when nothing in the output looks like a reason', async () => {
    const child = fakeChild();
    const p = login();
    child.emit('close', 3);
    const r = await p;
    expect(r.ok === false && r.error).toContain('3');
  });

  it('fails with the spawn error message', async () => {
    const child = fakeChild();
    const p = login();
    child.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ ok: false, error: 'ENOENT', output: '' });
  });

  it('retries once without --no-browser, and without onUrl, on an old CLI', async () => {
    const first = fakeChild();
    const onUrl = vi.fn();
    const p = login({ onUrl });
    first.stderr.emit('data', Buffer.from('Unknown options: --no-browser\n'));

    const second = fakeChild();
    first.emit('close', 2);
    // Let the retry's spawn happen before driving the second child.
    await Promise.resolve();
    second.stdout.emit('data', Buffer.from('https://oidc.example/authorize\n'));
    second.emit('close', 0);

    const r = await p;
    expect(r.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toEqual(['sso', 'login', '--profile', 'Zift']);
    // The old CLI opens its own browser; passing onUrl on would open a second tab.
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('does not retry a second time when the retry also fails', async () => {
    const first = fakeChild();
    const p = login();
    first.stderr.emit('data', Buffer.from('Unknown options: --no-browser\n'));
    const second = fakeChild();
    first.emit('close', 2);
    await Promise.resolve();
    second.stderr.emit('data', Buffer.from('Unknown options: --no-browser\n'));
    second.emit('close', 2);
    expect((await p).ok).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on an ordinary failure', async () => {
    const child = fakeChild();
    const p = login();
    child.stderr.emit('data', Buffer.from('Error: access denied\n'));
    child.emit('close', 255);
    expect((await p).ok).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('kills the child and fails once the timeout elapses', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const p = login({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    const r = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(r.ok === false && r.error).toContain('timed out');
  });

  it('ignores a late close after the timeout already settled', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const p = login({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    child.emit('close', 0);
    expect((await p).ok).toBe(false);
  });
});
