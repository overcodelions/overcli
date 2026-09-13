import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearCache,
  controlMachineService,
  listMachineServices,
  parseBrewServices,
  parseSystemdPlain,
  parseSystemdUnits,
  parseWindowsServices,
  serviceKey,
  type ExecFn,
} from './machineServices';

interface Call {
  file: string;
  args: string[];
}

/// A fake `execFile`: the first matching rule answers; anything unmatched is
/// ENOENT, which is what a missing program looks like.
function fakeExec(rules: Array<{ match: (c: Call) => boolean; stdout?: string; error?: Record<string, unknown> }>) {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args) => {
    const call = { file, args };
    calls.push(call);
    const rule = rules.find((r) => r.match(call));
    if (!rule) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    if (rule.error) throw Object.assign(new Error('Command failed'), rule.error);
    return { stdout: rule.stdout ?? '', stderr: '' };
  };
  return { exec, calls };
}

const has = (flag: string) => (c: Call) => c.args.includes(flag);

const BREW_JSON = JSON.stringify([
  { name: 'mariadb', status: 'started', user: 'lionel', file: '~/Library/LaunchAgents/homebrew.mxcl.mariadb.plist', exit_code: 0 },
  { name: 'memcached', status: 'stopped', user: null, file: '/opt/homebrew/opt/memcached/homebrew.mxcl.memcached.plist', exit_code: null },
  { name: 'postgresql@16', status: 'none', user: null, file: null, exit_code: null },
  { name: 'mysql@8.0', status: 'error', user: 'lionel', file: 'x', exit_code: 1 },
  { name: 'redis', status: 'scheduled', user: 'lionel', file: 'x', exit_code: null },
  { name: 'nginx', status: 'other', user: 'root', file: 'x', exit_code: null },
  { name: 'unbound', status: 'started', user: 'root', file: 'x', exit_code: 0 },
]);

const SYSTEMD_JSON = JSON.stringify([
  { unit: 'mariadb.service', load: 'loaded', active: 'active', sub: 'running', description: 'MariaDB 10.11 database server' },
  { unit: 'postgresql@16-main.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'PostgreSQL Cluster 16-main' },
  { unit: 'postgresql.service', load: 'loaded', active: 'active', sub: 'exited', description: 'PostgreSQL RDBMS' },
  { unit: 'redis-server.service', load: 'loaded', active: 'inactive', sub: 'dead', description: 'Advanced key-value store' },
  { unit: 'memcached.service', load: 'not-found', active: 'inactive', sub: 'dead', description: 'memcached.service' },
  { unit: 'cron.service', load: 'loaded', active: 'active', sub: 'running', description: 'Regular background program processing daemon' },
  { unit: 'docker.socket', load: 'loaded', active: 'active', sub: 'running', description: 'Docker Socket' },
  { unit: 'nginx.service', load: 'loaded', active: 'activating', sub: 'start', description: 'nginx' },
]);

const SYSTEMD_PLAIN = [
  'mariadb.service                loaded    active   running MariaDB 10.6 database server',
  '● postgresql@14-main.service   loaded    failed   failed  PostgreSQL Cluster 14-main',
  'ssh.service                    loaded    active   running OpenBSD Secure Shell server',
  'memcached.service              loaded    inactive dead    memcached daemon',
  '',
].join('\n');

describe('serviceKey', () => {
  it('reduces versioned and platform spellings to one key', () => {
    expect(serviceKey('postgresql@16-main.service')).toBe('postgresql');
    expect(serviceKey('postgresql-x64-16')).toBe('postgresql');
    expect(serviceKey('MySQL80')).toBe('mysql');
    expect(serviceKey('mysql@8.0')).toBe('mysql');
    expect(serviceKey('redis-server')).toBe('redis-server');
    expect(serviceKey('elasticsearch-service-x64')).toBe('elasticsearch-service');
  });
});

describe('parseBrewServices', () => {
  const services = parseBrewServices(BREW_JSON);
  const byName = Object.fromEntries(services.map((s) => [s.name, s]));

  it('keeps every brew service, allowlisted or not', () => {
    expect(services.map((s) => s.name)).toEqual(['mariadb', 'memcached', 'postgresql@16', 'mysql@8.0', 'redis', 'nginx', 'unbound']);
    expect(byName.unbound.port).toBeUndefined();
  });

  it('maps brew statuses', () => {
    expect(byName.mariadb.status).toBe('running');
    expect(byName.memcached.status).toBe('stopped');
    expect(byName['postgresql@16'].status).toBe('stopped');
    expect(byName['mysql@8.0'].status).toBe('error');
    expect(byName.redis.status).toBe('stopped');
    expect(byName.nginx.status).toBe('unknown');
  });

  it('knows ports and caches, including versioned formulas', () => {
    expect(byName.mariadb).toMatchObject({ id: 'brew:mariadb', manager: 'brew', port: 3306, user: 'lionel' });
    expect(byName['postgresql@16'].port).toBe(5432);
    expect(byName['mysql@8.0'].port).toBe(3306);
    expect(byName.redis).toMatchObject({ port: 6379, cache: 'redis' });
    expect(byName.memcached).toMatchObject({ port: 11211, cache: 'memcached' });
    expect(byName.nginx.port).toBe(8080);
    expect(byName.memcached.user).toBeUndefined();
    expect(byName.mariadb.needsAdmin).toBeUndefined();
  });

  it('survives empty output', () => {
    expect(parseBrewServices('')).toEqual([]);
    expect(parseBrewServices('[]')).toEqual([]);
  });
});

describe('parseSystemdUnits', () => {
  it('filters to the allowlist and maps state', () => {
    const services = parseSystemdUnits(SYSTEMD_JSON, false);
    expect(services.map((s) => [s.name, s.status])).toEqual([
      ['mariadb', 'running'],
      ['postgresql@16-main', 'error'],
      ['postgresql', 'stopped'],
      ['redis-server', 'stopped'],
      ['nginx', 'unknown'],
    ]);
    expect(services[0]).toMatchObject({ id: 'systemd:mariadb', manager: 'systemd', port: 3306, needsAdmin: true });
    expect(services[1].port).toBe(5432);
    expect(services[3].cache).toBe('redis');
    expect(services[4].port).toBe(80);
  });

  it('marks user units as not needing admin', () => {
    const [svc] = parseSystemdUnits(JSON.stringify([{ unit: 'valkey.service', load: 'loaded', active: 'active', sub: 'running' }]), true);
    expect(svc).toMatchObject({ id: 'systemd-user:valkey', manager: 'systemd-user', cache: 'redis', port: 6379 });
    expect(svc.needsAdmin).toBeUndefined();
  });
});

describe('parseSystemdPlain', () => {
  it('parses the pre-JSON output, including the failed-unit bullet', () => {
    const services = parseSystemdPlain(SYSTEMD_PLAIN, false);
    expect(services.map((s) => [s.name, s.status])).toEqual([
      ['mariadb', 'running'],
      ['postgresql@14-main', 'error'],
      ['memcached', 'stopped'],
    ]);
    expect(services[2]).toMatchObject({ cache: 'memcached', port: 11211, needsAdmin: true });
  });
});

describe('parseWindowsServices', () => {
  it('handles numeric statuses and filters to the allowlist', () => {
    const json = JSON.stringify([
      { Name: 'MySQL80', DisplayName: 'MySQL80', Status: 4, StartType: 2 },
      { Name: 'postgresql-x64-16', DisplayName: 'postgresql-x64-16 - PostgreSQL Server 16', Status: 1, StartType: 3 },
      { Name: 'Redis', DisplayName: 'Redis', Status: 2, StartType: 2 },
      { Name: 'Spooler', DisplayName: 'Print Spooler', Status: 4, StartType: 2 },
      { Name: 'MongoDB', DisplayName: 'MongoDB Server (MongoDB)', Status: 7, StartType: 2 },
    ]);
    const services = parseWindowsServices(json);
    expect(services.map((s) => [s.name, s.status, s.port])).toEqual([
      ['MySQL80', 'running', 3306],
      ['postgresql-x64-16', 'stopped', 5432],
      ['Redis', 'unknown', 6379],
      ['MongoDB', 'stopped', 27017],
    ]);
    expect(services[0]).toMatchObject({ id: 'windows:MySQL80', manager: 'windows', needsAdmin: true });
    expect(services[1].displayName).toBe('postgresql-x64-16 - PostgreSQL Server 16');
  });

  it('handles string statuses and a single unwrapped object', () => {
    const json = JSON.stringify({ Name: 'memcached', DisplayName: 'Memcached', Status: 'Running', StartType: 'Automatic' });
    expect(parseWindowsServices(json)).toEqual([
      { id: 'windows:memcached', name: 'memcached', displayName: 'Memcached', manager: 'windows', status: 'running', port: 11211, cache: 'memcached', needsAdmin: true },
    ]);
    expect(parseWindowsServices(JSON.stringify({ Name: 'RabbitMQ', Status: 'Stopped' }))[0]).toMatchObject({ status: 'stopped', port: 5672 });
  });
});

describe('listMachineServices', () => {
  it('darwin: uses the first brew candidate that exists', async () => {
    const { exec, calls } = fakeExec([{ match: (c) => c.file === '/usr/local/bin/brew', stdout: BREW_JSON }]);
    const services = await listMachineServices({ platform: 'darwin', exec, exists: (p) => p === '/usr/local/bin/brew' });
    expect(services).toHaveLength(7);
    expect(calls).toEqual([{ file: '/usr/local/bin/brew', args: ['services', 'list', '--json'] }]);
  });

  it('darwin: falls back to PATH, and no brew anywhere is an empty list', async () => {
    const { exec, calls } = fakeExec([]);
    expect(await listMachineServices({ platform: 'darwin', exec, exists: () => false })).toEqual([]);
    expect(calls[0].file).toBe('brew');
  });

  it('darwin: garbage output is an empty list, not a throw', async () => {
    const { exec } = fakeExec([{ match: () => true, stdout: 'Error: not json' }]);
    expect(await listMachineServices({ platform: 'darwin', exec, exists: () => true })).toEqual([]);
  });

  it('linux: merges system and user units, skipping brew when not installed', async () => {
    const { exec, calls } = fakeExec([
      { match: (c) => c.file === 'systemctl' && !has('--user')(c), stdout: SYSTEMD_JSON },
      { match: (c) => c.file === 'systemctl' && has('--user')(c), stdout: JSON.stringify([{ unit: 'redis.service', load: 'loaded', active: 'active', sub: 'running' }]) },
    ]);
    const services = await listMachineServices({ platform: 'linux', exec, exists: () => false });
    expect(services.map((s) => s.id)).toEqual([
      'systemd:mariadb',
      'systemd:postgresql@16-main',
      'systemd:postgresql',
      'systemd:redis-server',
      'systemd:nginx',
      'systemd-user:redis',
    ]);
    expect(calls.some((c) => c.file === 'brew')).toBe(false);
  });

  it('linux: includes linuxbrew when present', async () => {
    const { exec } = fakeExec([
      { match: (c) => c.file === '/home/linuxbrew/.linuxbrew/bin/brew', stdout: JSON.stringify([{ name: 'redis', status: 'started' }]) },
      { match: (c) => c.file === 'systemctl', stdout: '[]' },
    ]);
    const services = await listMachineServices({ platform: 'linux', exec, exists: (p) => p.startsWith('/home/linuxbrew') });
    expect(services.map((s) => s.id)).toEqual(['brew:redis']);
  });

  it('linux: falls back to plain output when --output=json is unsupported', async () => {
    const { exec, calls } = fakeExec([
      { match: has('--output=json'), error: { code: 1, stderr: "Unknown output 'json'." } },
      { match: (c) => has('--plain')(c) && !has('--user')(c), stdout: SYSTEMD_PLAIN },
      { match: (c) => has('--plain')(c) && has('--user')(c), error: { code: 1, stderr: 'Failed to connect to bus' } },
    ]);
    const services = await listMachineServices({ platform: 'linux', exec, exists: () => false });
    expect(services.map((s) => s.id)).toEqual(['systemd:mariadb', 'systemd:postgresql@14-main', 'systemd:memcached']);
    expect(calls.filter((c) => has('--plain')(c))).toHaveLength(2);
  });

  it('linux: no systemctl at all is an empty list', async () => {
    const { exec } = fakeExec([]);
    expect(await listMachineServices({ platform: 'linux', exec, exists: () => false })).toEqual([]);
  });

  it('win32: runs Get-Service through powershell', async () => {
    const { exec, calls } = fakeExec([{ match: (c) => c.file === 'powershell', stdout: JSON.stringify({ Name: 'Redis', Status: 4 }) }]);
    const services = await listMachineServices({ platform: 'win32', exec });
    expect(services.map((s) => s.id)).toEqual(['windows:Redis']);
    expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0].args[3]).toContain('Get-Service');
  });

  it('unsupported platforms are an empty list without shelling out', async () => {
    const { exec, calls } = fakeExec([]);
    expect(await listMachineServices({ platform: 'freebsd', exec })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('controlMachineService', () => {
  it('builds the command for each manager', async () => {
    const { exec, calls } = fakeExec([{ match: () => true }]);
    const exists = (p: string) => p === '/opt/homebrew/bin/brew';
    expect(await controlMachineService({ name: 'mariadb', manager: 'brew' }, 'restart', { exec, exists })).toEqual({ ok: true });
    await controlMachineService({ name: 'postgresql@16-main', manager: 'systemd' }, 'start', { exec });
    await controlMachineService({ name: 'redis', manager: 'systemd-user' }, 'stop', { exec });
    await controlMachineService({ name: 'MySQL80', manager: 'windows' }, 'restart', { exec });
    expect(calls).toEqual([
      { file: '/opt/homebrew/bin/brew', args: ['services', 'restart', 'mariadb'] },
      { file: 'systemctl', args: ['--no-ask-password', 'start', 'postgresql@16-main'] },
      { file: 'systemctl', args: ['--user', 'stop', 'redis'] },
      { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', "Restart-Service -Name 'MySQL80' -ErrorAction Stop"] },
    ]);
  });

  it('explains access denied for system units', async () => {
    const { exec } = fakeExec([{ match: () => true, error: { code: 1, stderr: 'Failed to start mariadb.service: Access denied\n' } }]);
    const result = await controlMachineService({ name: 'mariadb', manager: 'systemd' }, 'start', { exec });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('sudo systemctl start mariadb') });
  });

  it('explains access denied for Windows services', async () => {
    const { exec } = fakeExec([
      { match: () => true, error: { code: 1, stderr: "Stop-Service : Service 'Redis (Redis)' cannot be stopped due to the following error: Cannot open Redis service on computer '.'." } },
    ]);
    const result = await controlMachineService({ name: 'Redis', manager: 'windows' }, 'stop', { exec });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('administrator') });
  });

  it('reports other failures with their first line', async () => {
    const { exec } = fakeExec([{ match: () => true, error: { code: 1, stderr: 'Error: Formula `nope` is not installed.\nmore' } }]);
    const result = await controlMachineService({ name: 'nope', manager: 'brew' }, 'start', { exec, exists: () => true });
    expect(result).toEqual({ ok: false, reason: 'start nope failed: Error: Formula `nope` is not installed.' });
  });

  it('reports a missing manager', async () => {
    const { exec } = fakeExec([]);
    const result = await controlMachineService({ name: 'redis', manager: 'systemd-user' }, 'start', { exec });
    expect(result).toEqual({ ok: false, reason: 'systemctl is not installed or not on PATH' });
  });

  it('refuses names that could smuggle a command', async () => {
    const { exec, calls } = fakeExec([{ match: () => true }]);
    const result = await controlMachineService({ name: "x'; Remove-Item C:\\ -Recurse; '", manager: 'windows' }, 'stop', { exec });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('clearCache', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /// A one-shot server: records what it was sent and answers with `reply`
  /// (or never answers, when `reply` is undefined).
  async function serve(reply: string | undefined): Promise<{ port: number; received: () => string }> {
    let received = '';
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => {
        received += d;
        if (reply !== undefined) sock.write(reply);
      });
      sock.on('error', () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, received: () => received };
  }

  it('flushes memcached', async () => {
    const s = await serve('OK\r\n');
    expect(await clearCache('memcached', s.port)).toEqual({ ok: true });
    expect(s.received()).toBe('flush_all\r\n');
  });

  it('flushes redis with RESP', async () => {
    const s = await serve('+OK\r\n');
    expect(await clearCache('redis', s.port)).toEqual({ ok: true });
    expect(s.received()).toBe('*1\r\n$8\r\nFLUSHALL\r\n');
  });

  it('explains NOAUTH and other redis errors', async () => {
    const auth = await serve('-NOAUTH Authentication required.\r\n');
    expect(await clearCache('redis', auth.port)).toEqual({ ok: false, reason: expect.stringContaining('requires a password') });
    const err = await serve("-ERR unknown command 'FLUSHALL'\r\n");
    expect(await clearCache('redis', err.port)).toEqual({ ok: false, reason: `redis on :${err.port} refused: ERR unknown command 'FLUSHALL'` });
  });

  it('explains memcached errors', async () => {
    const s = await serve('SERVER_ERROR out of memory\r\n');
    expect(await clearCache('memcached', s.port)).toEqual({ ok: false, reason: `memcached on :${s.port} refused: SERVER_ERROR out of memory` });
  });

  it('says nothing is listening when refused', async () => {
    const s = await serve('OK\r\n');
    const port = s.port;
    await new Promise((r) => servers.pop()!.close(r));
    expect(await clearCache('redis', port)).toEqual({ ok: false, reason: `nothing listening on :${port}` });
  });

  it('times out when the server never answers', async () => {
    const s = await serve(undefined);
    const started = Date.now();
    expect(await clearCache('memcached', s.port, '127.0.0.1', { timeoutMs: 50 })).toEqual({
      ok: false,
      reason: `no answer from memcached on :${s.port} within 50ms`,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a nonsense port without connecting', async () => {
    expect(await clearCache('redis', 0)).toEqual({ ok: false, reason: '0 is not a port' });
  });
});
