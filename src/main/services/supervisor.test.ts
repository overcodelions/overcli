import { describe, expect, it, vi } from 'vitest';
import { maskSecrets, Supervisor, type SpawnRequest, type SpawnedProcess, type SupervisorDeps } from './supervisor';
import type { ProjectionFs } from './projection';
import type { ServiceBinding, ServiceSpec } from './types';

/// A checkout that exists and resolves to itself; enough for projection.
const fs: ProjectionFs = {
  existsSync: () => true,
  realpathSync: (p) => p,
  readFileSync: () => '',
  writeFileSync: () => {},
  mkdirSync: () => {},
  symlinkSync: () => {},
  lstatSync: () => ({ isSymbolicLink: () => false }),
  statSync: () => ({ isDirectory: () => true }),
  readlinkSync: () => '',
  unlinkSync: () => {},
};

class FakeProc implements SpawnedProcess {
  pid = 4242;
  killed: NodeJS.Signals[] = [];
  private lineCb: (line: string) => void = () => {};
  private exitCb: (code: number | null) => void = () => {};
  private errorCb: (err: Error) => void = () => {};
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? 'SIGTERM');
  }
  onLine(cb: (line: string) => void) {
    this.lineCb = cb;
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCb = cb;
  }
  onError(cb: (err: Error) => void) {
    this.errorCb = cb;
  }
  emitLine(line: string) {
    this.lineCb(line);
  }
  emitExit(code: number | null) {
    this.exitCb(code);
  }
  emitError(err: Error) {
    this.errorCb(err);
  }
}

function harness(over: Partial<SupervisorDeps> = {}) {
  const spawns: SpawnRequest[] = [];
  const procs: FakeProc[] = [];
  let clock = 0;
  const deps: SupervisorDeps = {
    spawn: (req) => {
      spawns.push(req);
      const proc = new FakeProc();
      procs.push(proc);
      return proc;
    },
    probe: {
      httpStatus: async () => 200,
      tcpOpen: async () => true,
      exitCode: async () => 0,
      now: () => clock++,
      sleep: async () => {},
    },
    fs,
    configDir: (id) => `/cfg/${id}`,
    ...over,
  };
  return { deps, spawns, procs };
}

function spec(over: Partial<ServiceSpec> & { id: string }): ServiceSpec {
  return {
    name: over.id,
    runner: 'command',
    command: ['run', over.id],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    ...over,
  };
}

function binding(serviceId: string, ref = 'master', path = '/repos/main'): ServiceBinding {
  return { serviceId, ref, path };
}

describe('maskSecrets', () => {
  it('masks every occurrence of a known secret, longest first', () => {
    expect(maskSecrets('password=hunter2hunter2 again hunter2hunter2', ['hunter2', 'hunter2hunter2'])).toBe(
      'password=•••••• again ••••••',
    );
  });

  it('leaves values too short to be anything but ordinary words', () => {
    expect(maskSecrets('connecting as root', ['root'])).toBe('connecting as root');
  });
});

describe('Supervisor.start', () => {
  it('reports the actual debugger endpoint and launches through the runner adapter', async () => {
    const { deps, spawns } = harness();
    const api = spec({
      id: 'api', runner: 'python', command: ['python', 'app.py'],
      debugKind: 'debugpy', debugPort: 5678, debugEnabled: true,
    });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    await sup.start('api', { offset: 1 });

    expect(spawns[0].command.slice(0, 6)).toEqual([
      'python', '-m', 'debugpy', '--listen', '127.0.0.1:15678', 'app.py',
    ]);
    expect(sup.runtime('api')).toMatchObject({ debugKind: 'debugpy', debugPort: 15678 });
    expect(sup.claims().map((c) => c.port)).toContain(15678);
  });

  it('launches a service that lives in a subfolder from that subfolder', async () => {
    // admin-console: the repo is acme-admin-console, the app is admin-ui inside it.
    const { deps, spawns } = harness();
    const ui = spec({ id: 'ui', subpath: 'admin-ui' });
    const sup = new Supervisor('mine', [ui], [binding('ui', 'master', '/repos/admin-console')], deps);

    await sup.start('ui');

    expect(spawns[0].cwd).toBe('/repos/admin-console/admin-ui');
  });

  it('launches in the bound checkout with the projected env', async () => {
    const { deps, spawns } = harness();
    const api = spec({
      id: 'api',
      port: 8080,
      config: { inject: { SPRING_CONFIG_ADDITIONAL_LOCATION: '${SERVICE_CONFIG_DIR}/' } },
    });
    const sup = new Supervisor('mine', [api], [binding('api', 'feat/x', '/wt/x')], deps);

    await sup.start('api');

    expect(spawns).toHaveLength(1);
    expect(spawns[0].cwd).toBe('/wt/x');
    // `${SERVICE_CONFIG_DIR}` resolves to the service's own config directory,
    // which lives outside every checkout.
    expect(spawns[0].env.SPRING_CONFIG_ADDITIONAL_LOCATION).toBe('/cfg/api/');
    expect(sup.runtime('api').status).toBe('ready');
    expect(sup.runtime('api').port).toBe(8080);
  });

  it('runs a command naming ${CHECKOUT} against whichever worktree it is switched to', async () => {
    const { deps, spawns } = harness();
    const web = spec({ id: 'web', command: ['sh', '-c', 'ln -sfn "${CHECKOUT}" /srv/web-active'] });
    const sup = new Supervisor('mine', [web], [binding('web')], deps);

    await sup.start('web');
    await sup.rebind('web', { ref: 'feat/x', path: '/wt/x' });

    expect(spawns.map((s) => s.command[2])).toEqual([
      'ln -sfn "/repos/main" /srv/web-active',
      'ln -sfn "/wt/x" /srv/web-active',
    ]);
    expect(spawns[1].env.OVERCLI_CHECKOUT).toBe('/wt/x');
  });

  it('brings dependencies up first, in order', async () => {
    const { deps, spawns } = harness();
    const specs = [spec({ id: 'web', deps: ['api'] }), spec({ id: 'api', deps: ['db'] }), spec({ id: 'db' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('web');

    expect(spawns.map((s) => s.command[1])).toEqual(['db', 'api', 'web']);
  });

  it('reports a port clash instead of taking the port', async () => {
    const { deps, spawns } = harness();
    const api = spec({ id: 'api', port: 8080 });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    const result = await sup.start('api', {
      foreign: [{ port: 8080, serviceId: 'api', stackId: 'theirs', holder: 'flow ui poll' }],
    });

    expect(result.started).toBe(false);
    expect(result.lease?.kind).toBe('held');
    expect(spawns).toHaveLength(0);
  });

  it('runs beside the other stack when told to take the offset', async () => {
    const { deps } = harness();
    const api = spec({ id: 'api', port: 8080 });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    await sup.start('api', { offset: 1 });

    expect(sup.runtime('api').port).toBe(18080);
  });

  it('fails with a plain reason when the worktree has gone', async () => {
    // Flows delete their scratch worktree mid-session; this is routine and
    // the message has to say what actually happened.
    const gone: ProjectionFs = { ...fs, existsSync: () => false };
    const { deps } = harness({ fs: gone });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api', 'feat/x', '/wt/gone')], deps);

    await sup.start('api');

    expect(sup.runtime('api').status).toBe('failed');
    expect(sup.runtime('api').lastError).toMatch(/no longer exists/);
  });

  it('refuses to launch under a workspace symlink root', async () => {
    const { deps, spawns } = harness({ symlinkRoots: ['/userData/workspaces'] });
    const sup = new Supervisor(
      'mine',
      [spec({ id: 'api' })],
      [binding('api', 'master', '/userData/workspaces/w1/api')],
      deps,
    );

    await sup.start('api');

    expect(spawns).toHaveLength(0);
    expect(sup.runtime('api').lastError).toMatch(/symlink root/);
  });
});

describe('Supervisor code watching', () => {
  it('debounces matching changes and restarts an opted-in live service', async () => {
    vi.useFakeTimers();
    try {
      let changed: ((path: string) => void) | undefined;
      const close = vi.fn();
      const { deps, spawns } = harness({
        watchFiles: (_checkout, _patterns, onChange) => {
          changed = onChange;
          return { close };
        },
      });
      const api = spec({ id: 'api', watch: ['src/**'] });
      const sup = new Supervisor('mine', [api], [binding('api')], deps);

      await sup.start('api');
      changed?.('src/App.java');
      changed?.('src/Other.java');
      await vi.advanceTimersByTimeAsync(499);
      expect(spawns).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(spawns).toHaveLength(2);
      expect(close).toHaveBeenCalledTimes(1);
      expect(sup.log('api')).toContain('── code changed · src/Other.java · restarting ──');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not install an outer watcher for a self-reloading service', async () => {
    const watchFiles = vi.fn(() => ({ close: vi.fn() }));
    const { deps } = harness({ watchFiles });
    const vite = spec({ id: 'web', selfReloads: true, watch: ['src/**'] });
    const sup = new Supervisor('mine', [vite], [binding('web')], deps);

    await sup.start('web');

    expect(watchFiles).not.toHaveBeenCalled();
  });

  it('reconfigures watching when service settings change without restarting it', async () => {
    const close = vi.fn();
    const watchFiles = vi.fn(() => ({ close }));
    const { deps, spawns } = harness({ watchFiles });
    const api = spec({ id: 'api' });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);
    await sup.start('api');

    sup.update([{ ...api, watch: ['app/**'] }], [binding('api')]);

    expect(spawns).toHaveLength(1);
    expect(watchFiles).toHaveBeenCalledWith('/repos/main', ['app/**'], expect.any(Function));
  });
});

describe('Supervisor readiness', () => {
  it('waits for the log pattern a dev server prints', async () => {
    const { deps, procs } = harness();
    const web = spec({ id: 'web', ready: { kind: 'log', pattern: 'Compiled successfully' } });
    const sup = new Supervisor('mine', [web], [binding('web')], deps);

    const started = sup.start('web');
    // The line arrives after the spawn, as it does in life.
    await Promise.resolve();
    procs[0]?.emitLine('✔ Compiled successfully.');
    await started;

    expect(sup.runtime('web').status).toBe('ready');
  });

  it('keeps the exit reason when a service dies on its way up', async () => {
    const { deps, procs } = harness({
      probe: {
        httpStatus: async () => {
          throw new Error('ECONNREFUSED');
        },
        tcpOpen: async () => false,
        exitCode: async () => 1,
        now: () => 0,
        sleep: async () => {},
      },
    });
    const api = spec({ id: 'api', port: 8080, ready: { kind: 'tcp', port: 8080 } });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    const started = sup.start('api');
    await Promise.resolve();
    procs[0]?.emitExit(1);
    await started;

    // `failed` with an exit code, not the vaguer `unready`.
    expect(sup.runtime('api').status).toBe('failed');
    expect(sup.runtime('api').exitCode).toBe(1);
  });
});

describe('Supervisor spawn failures', () => {
  it('records a spawn error instead of letting it reach the main process', async () => {
    // Node emits this on the child rather than throwing; an adapter that
    // ignores it takes down every conversation, flow run and shift at once.
    const { deps, procs } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);

    const started = sup.start('api');
    await Promise.resolve();
    procs[0]?.emitError(new Error('spawn ./mvnw ENOENT'));
    await started;

    expect(sup.runtime('api').status).toBe('failed');
    expect(sup.runtime('api').lastError).toMatch(/ENOENT/);
  });
});

describe('Supervisor.rebind', () => {
  it('moves the service to the new checkout and restarts it there', async () => {
    const { deps, spawns } = harness();
    const api = spec({ id: 'api' });
    const sup = new Supervisor('mine', [api], [binding('api', 'master', '/repos/main')], deps);
    await sup.start('api');

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(spawns.map((s) => s.cwd)).toEqual(['/repos/main', '/wt/x']);
    expect(sup.runtime('api').status).toBe('ready');
  });

  it('writes a marker into the log where the binding changed', async () => {
    // So "this broke when I switched branches" is visible rather than
    // remembered.
    const { deps } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(sup.log('api').some((l) => l.includes('rebound master → feat/x'))).toBe(true);
  });

  it('leaves a stopped service stopped', async () => {
    const { deps, spawns } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(spawns).toHaveLength(0);
    expect(sup.runtime('api').status).toBe('stopped');
  });

  it('refuses to move a pinned service', async () => {
    // "Pin the backends, float the frontend" only works if the pin holds.
    const { deps, spawns } = harness();
    const api = spec({ id: 'api', pinnedRef: 'master' });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);
    await sup.start('api');

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(spawns.map((s) => s.cwd)).toEqual(['/repos/main']);
  });

  it('moves everything unpinned in one go', async () => {
    const { deps } = harness();
    const specs = [
      spec({ id: 'api' }),
      spec({ id: 'web' }),
      spec({ id: 'security', pinnedRef: 'master' }),
    ];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const moved = await sup.rebindAll(
      specs.map((s) => ({ serviceId: s.id, ref: 'feat/x', path: '/wt/x' })),
    );

    expect(moved).toEqual(['api', 'web']);
  });
});

describe('Supervisor.restart', () => {
  it('does not take dependents down with it', async () => {
    // An HTTP client reconnects. This is the default that keeps a backend
    // restart from costing you your frontend state.
    const { deps, spawns } = harness();
    const specs = [spec({ id: 'api' }), spec({ id: 'web', deps: ['api'] })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('web');
    spawns.length = 0;

    await sup.restart('api');

    expect(spawns.map((s) => s.command[1])).toEqual(['api']);
  });

  it('restarts dependents where the edge was marked', async () => {
    const { deps, spawns } = harness();
    const specs = [spec({ id: 'api', restartDependents: true }), spec({ id: 'web', deps: ['api'] })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('web');
    spawns.length = 0;

    await sup.restart('api');

    expect(spawns.map((s) => s.command[1])).toEqual(['api', 'web']);
  });

  it('comes back on the same offset port it was already using', async () => {
    const { deps } = harness();
    const api = spec({ id: 'api', port: 8080 });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);
    await sup.start('api', { offset: 1 });

    await sup.restart('api');

    expect(sup.runtime('api').port).toBe(18080);
  });
});

describe('Supervisor.claims', () => {
  it('reports the ports this stack holds, for another stack to check against', async () => {
    const { deps } = harness();
    const specs = [spec({ id: 'api', port: 8080 }), spec({ id: 'idle', port: 9999 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('api');

    expect(sup.claims()).toEqual([
      expect.objectContaining({ port: 8080, serviceId: 'api', stackId: 'mine' }),
    ]);
  });
});

describe('a slow start', () => {
  it('is called slow past its allowance, and turns ready when it finally answers', async () => {
    let clock = 0;
    const { deps } = harness({
      probe: {
        httpStatus: async () => 200,
        tcpOpen: async () => clock >= 90_000,
        exitCode: async () => 0,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      },
    });
    const api = spec({ id: 'api', port: 8080, ready: { kind: 'tcp', port: 8080 }, readyTimeoutSec: 30 });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    await sup.start('api');
    expect(sup.runtime('api').status).toBe('unready');

    await vi.waitFor(() => expect(sup.runtime('api').status).toBe('ready'));
  });
});

describe('a task', () => {
  /// Let the start reach its spawn before the fake process is told to exit.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is done when it exits cleanly, on the ref it ran from', async () => {
    const { deps, procs } = harness();
    const publish = spec({ id: 'publish', task: true });
    const sup = new Supervisor('mine', [publish], [binding('publish', 'feat/x')], deps);

    const run = sup.start('publish');
    await settle();
    procs[0].emitExit(0);
    await run;

    expect(sup.runtime('publish')).toMatchObject({ status: 'done', ranRef: 'feat/x' });
    // Done is not holding anything.
    expect(sup.claims()).toEqual([]);
  });

  it('shows its dependent as waiting, and a stop while it waits calls the start off', async () => {
    const { deps, spawns, procs } = harness();
    const specs = [spec({ id: 'api', deps: ['publish'] }), spec({ id: 'publish', task: true })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const run = sup.start('api');
    await settle();
    expect(sup.runtime('api')).toMatchObject({ status: 'starting', waitingOn: 'publish' });

    await sup.stop('api');
    expect(sup.runtime('api').status).toBe('stopped');
    procs[0].emitExit(0);
    await run;

    expect(spawns.map((s) => s.command[1])).toEqual(['publish']);
    expect(sup.runtime('api')).toMatchObject({ status: 'stopped', waitingOn: undefined });
  });

  it('runs before its dependent, which waits for it to finish', async () => {
    const { deps, spawns, procs } = harness();
    const specs = [spec({ id: 'api', deps: ['publish'] }), spec({ id: 'publish', task: true })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const started = sup.start('api');
    await settle();
    // Still publishing: the dependent has not been launched.
    expect(spawns.map((s) => s.command[1])).toEqual(['publish']);
    procs[0].emitExit(0);
    await started;

    expect(spawns.map((s) => s.command[1])).toEqual(['publish', 'api']);
    expect(sup.runtime('api').status).toBe('ready');
  });

  it('is not run again for a dependent on the same ref', async () => {
    const { deps, spawns, procs } = harness();
    const specs = [
      spec({ id: 'api', deps: ['publish'] }),
      spec({ id: 'web', deps: ['publish'] }),
      spec({ id: 'publish', task: true }),
    ];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const api = sup.start('api');
    await settle();
    procs[0].emitExit(0);
    await api;
    await sup.start('web');

    expect(spawns.map((s) => s.command[1])).toEqual(['publish', 'api', 'web']);
  });

  it('runs again once it has been moved to another branch', async () => {
    const { deps, spawns, procs } = harness();
    const specs = [spec({ id: 'api', deps: ['publish'] }), spec({ id: 'publish', task: true })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const first = sup.start('api');
    await settle();
    procs[0].emitExit(0);
    await first;
    await sup.stop('api');
    await sup.rebind('publish', { ref: 'feat/y', path: '/wt/y' });

    const second = sup.start('api');
    await settle();
    procs[2].emitExit(0);
    await second;

    expect(spawns.map((s) => s.command[1])).toEqual(['publish', 'api', 'publish', 'api']);
    expect(sup.runtime('publish').ranRef).toBe('feat/y');
  });

  it('keeps its dependent from starting when it fails', async () => {
    const { deps, spawns, procs } = harness();
    const specs = [spec({ id: 'api', deps: ['publish'] }), spec({ id: 'publish', name: 'common-publish', task: true })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const started = sup.start('api');
    await settle();
    procs[0].emitExit(1);
    const result = await started;

    expect(result.started).toBe(false);
    expect(spawns).toHaveLength(1);
    expect(sup.runtime('publish').status).toBe('failed');
    expect(sup.runtime('api').lastError).toMatch(/common-publish did not finish/);
  });

  it('lets a waiting dependent go when the task is stopped', async () => {
    // A stop's exit is ignored as a status; it must still release the wait.
    const { deps, procs } = harness();
    const specs = [spec({ id: 'api', deps: ['publish'] }), spec({ id: 'publish', task: true })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const started = sup.start('api');
    await settle();
    await sup.stop('publish');
    // The SIGTERM'd process exits a moment later, as it does in life.
    procs[0].emitExit(null);

    expect((await started).started).toBe(false);
  });

  it('says so when it ran from another branch of the same project', async () => {
    const { deps, procs } = harness();
    const specs = [
      spec({ id: 'api', projectId: 'common', deps: ['publish'] }),
      spec({ id: 'publish', name: 'common-publish', projectId: 'common', task: true, pinnedRef: 'master' }),
    ];
    const sup = new Supervisor(
      'mine',
      specs,
      [binding('api', 'feat/x', '/wt/x'), binding('publish', 'master')],
      deps,
    );

    const started = sup.start('api');
    await settle();
    procs[0].emitExit(0);
    await started;

    expect(sup.log('api')).toContain('── common-publish last ran from master; this starts from feat/x ──');
  });
});

describe('Supervisor.update', () => {
  it('takes an edit without forgetting the services that stayed', async () => {
    const { deps, procs } = harness();
    const specs = [spec({ id: 'api' }), spec({ id: 'web' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('api');
    await sup.start('web');
    procs[0].emitLine('api says hello');

    sup.update([specs[0]], [binding('api')]);

    // The one that stayed is still running and still has its output.
    expect(sup.runtime('api').status).toBe('ready');
    expect(sup.log('api')).toContain('api says hello');
    // The one that went is stopped, and its late exit does not bring it back.
    expect(procs[1].killed).toEqual(['SIGTERM']);
    procs[1].emitExit(null);
    expect(sup.runtime('web')).toEqual({ serviceId: 'web', status: 'stopped' });
  });

  it('ignores the exit of a process a restart already replaced', async () => {
    const { deps, procs } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');
    await sup.restart('api');

    procs[0].emitExit(null);

    expect(sup.runtime('api').status).toBe('ready');
  });
});

describe('Supervisor local config mirror', () => {
  function mirroring() {
    const calls: [string, string][] = [];
    const h = harness({
      mirrorLocalConfig: (serviceId, checkout) => {
        calls.push([serviceId, checkout]);
        return ['src/main/resources/application-local.properties'];
      },
    });
    return { ...h, calls };
  }

  it('mirrors into the checkout before every launch, and says so in the log', async () => {
    const { deps, calls, spawns } = mirroring();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api', 'master', '/wt/a')], deps);

    await sup.start('api');

    expect(calls).toEqual([['api', '/wt/a']]);
    expect(spawns).toHaveLength(1);
    expect(sup.log('api').some((l) => l.includes('brought 1 local config file in'))).toBe(true);
  });

  it('mirrors into the NEW checkout when a branch switch relaunches the service', async () => {
    // The switch restarted acme-rest on its feature worktree without its
    // application-local.properties; pressing Start afterwards brought them in.
    const { deps, calls, spawns } = mirroring();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api', 'master', '/repos/main')], deps);
    await sup.start('api');
    calls.length = 0;

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(calls).toEqual([['api', '/wt/x']]);
    expect(spawns.map((s) => s.cwd)).toEqual(['/repos/main', '/wt/x']);
  });

  it('mirrors on restart, for a dependency started first, and for a dependent restarted after', async () => {
    const { deps, calls } = mirroring();
    const specs = [spec({ id: 'api', restartDependents: true }), spec({ id: 'web', deps: ['api'] })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('web');
    expect(calls.map(([id]) => id)).toEqual(['api', 'web']);

    calls.length = 0;
    await sup.restart('api');
    expect(calls.map(([id]) => id)).toEqual(['api', 'web']);
  });

  it('writes no marker when nothing needed linking', async () => {
    const { deps } = harness({ mirrorLocalConfig: () => [] });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);

    await sup.start('api');

    expect(sup.log('api').some((l) => l.includes('local config'))).toBe(false);
  });
});

describe('Supervisor stopping and switching', () => {
  it('waits for the old process to exit before launching the next', async () => {
    // A JVM still holding :8088 made the new launch look ready at once.
    const { deps, spawns, procs } = harness();
    deps.probe = { ...deps.probe, sleep: () => new Promise<void>(() => {}) };
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');

    const restarting = sup.restart('api');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(spawns).toHaveLength(1);

    procs[0].emitExit(null);
    await restarting;
    expect(spawns).toHaveLength(2);
  });

  it('mirrors into the new checkout of a stopped service without starting it', async () => {
    const calls: string[] = [];
    const { deps, spawns } = harness({
      mirrorLocalConfig: async (_id, checkout) => {
        calls.push(checkout);
        return ['a.properties', 'b.properties'];
      },
    });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api', 'master', '/repos/main')], deps);

    await sup.rebind('api', { ref: 'feat/x', path: '/wt/x' });

    expect(calls).toEqual(['/wt/x']);
    expect(spawns).toHaveLength(0);
    expect(sup.log('api').some((l) => l.includes('brought 2 local config files in'))).toBe(true);
  });
});
