import { describe, expect, it } from 'vitest';
import { runRepoTests, type RepoTestDeps } from './repoTests';

type Call = { file: string; args: string[]; options: Parameters<RepoTestDeps['execFile']>[2] };

/// An execFile stand-in: records the call, then answers as `outcome` says.
function fakeExec(outcome: { err?: Error; stdout?: string; stderr?: string } | { throws: Error }) {
  const calls: Call[] = [];
  const execFile: RepoTestDeps['execFile'] = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if ('throws' in outcome) throw outcome.throws;
    callback(outcome.err ?? null, outcome.stdout ?? '', outcome.stderr ?? '');
  };
  return { calls, execFile };
}

describe('running a repo\'s tests', () => {
  it('refuses without running anything when there is no safe user, and says so as a refusal', async () => {
    const exec = fakeExec({});
    const res = await runRepoTests('npm test', '/repos/acme-app', { env: {}, execFile: exec.execFile });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(res.ok === false && res.error).toContain('OVERCLI_TEST_UID');
    expect(exec.calls).toEqual([]);

    const root = await runRepoTests('npm test', '/repos/acme-app', { env: { OVERCLI_TEST_UID: '0' }, execFile: exec.execFile });
    expect(root).toMatchObject({ ok: false, refused: true });
    expect(exec.calls).toEqual([]);
  });

  it('runs as the test user, with the group defaulting to the user\'s id', async () => {
    const exec = fakeExec({});
    expect(await runRepoTests('npm test', '/repos/acme-app', { env: { OVERCLI_TEST_UID: ' 1001 ' }, execFile: exec.execFile })).toEqual({ ok: true });
    expect(exec.calls[0]).toMatchObject({ file: '/bin/sh', args: ['-c', 'npm test'], options: { cwd: '/repos/acme-app', uid: 1001, gid: 1001 } });

    await runRepoTests('npm test', '/repos/acme-app', { env: { OVERCLI_TEST_UID: '1001', OVERCLI_TEST_GID: '2002' }, execFile: exec.execFile });
    expect(exec.calls[1].options).toMatchObject({ uid: 1001, gid: 2002 });
  });

  it('runs as the server, with no uid or gid, when the operator accepts that', async () => {
    const exec = fakeExec({});
    expect(await runRepoTests('npm test', '/repos/acme-app', { env: { OVERCLI_TEST_AS_SERVER: '1' }, execFile: exec.execFile })).toEqual({ ok: true });
    expect(exec.calls[0].options).not.toHaveProperty('uid');
    expect(exec.calls[0].options).not.toHaveProperty('gid');
  });

  it('keeps the server\'s secrets out of the tests\' environment', async () => {
    const exec = fakeExec({});
    await runRepoTests('npm test', '/repos/acme-app', { env: { OVERCLI_TEST_AS_SERVER: '1', GH_TOKEN: 'ghs_acme', PATH: '/usr/bin' }, execFile: exec.execFile });
    expect(exec.calls[0].options.env).not.toHaveProperty('GH_TOKEN');
    expect(exec.calls[0].options.env).toMatchObject({ PATH: '/usr/bin' });
  });

  it('gives the tests\' output when they fail, or the error when there is none', async () => {
    const failed = fakeExec({ err: new Error('exit 1'), stdout: '1 failing\n', stderr: 'AssertionError' });
    expect(await runRepoTests('npm test', '/x', { env: { OVERCLI_TEST_AS_SERVER: '1' }, execFile: failed.execFile })).toEqual({ ok: false, error: '1 failing\nAssertionError' });
    const silent = fakeExec({ err: new Error('Command failed: npm test') });
    expect(await runRepoTests('npm test', '/x', { env: { OVERCLI_TEST_AS_SERVER: '1' }, execFile: silent.execFile })).toEqual({ ok: false, error: 'Command failed: npm test' });
  });

  it('says what went wrong when the run throws before it starts, naming the user only when there is one', async () => {
    const bad = fakeExec({ throws: new RangeError('The value of "options.uid" is out of range') });
    expect(await runRepoTests('npm test', '/x', { env: { OVERCLI_TEST_UID: '99999999999' }, execFile: bad.execFile })).toEqual({
      ok: false,
      error: 'Could not run the tests as user 99999999999: The value of "options.uid" is out of range',
    });
    expect(await runRepoTests('npm test', '/x', { env: { OVERCLI_TEST_UID: '1001', OVERCLI_TEST_GID: '2002' }, execFile: bad.execFile })).toEqual({
      ok: false,
      error: 'Could not run the tests as user 1001 (group 2002): The value of "options.uid" is out of range',
    });
    expect(await runRepoTests('npm test', '/x', { env: { OVERCLI_TEST_AS_SERVER: '1' }, execFile: bad.execFile })).toEqual({
      ok: false,
      error: 'Could not run the tests: The value of "options.uid" is out of range',
    });
  });
});
