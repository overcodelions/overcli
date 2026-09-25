import { describe, expect, it, vi } from 'vitest';
import {
  ADOPTED_POLL_MS,
  LOG_LIMIT,
  maskSecrets,
  Supervisor,
  type SpawnRequest,
  type SpawnedProcess,
  type SupervisorDeps,
} from './supervisor';
import type { ProjectionFs } from './projection';
import type { ServiceBinding, ServiceSpec } from './types';
import type { PortHolderKind } from '../../shared/services';
import { matchingProcesses, type PortOwner, type ProcessMatch } from './portOwners';
import { LaunchGate } from './launchGate';

/// A checkout that exists and resolves to itself; enough for projection.
const fs: ProjectionFs = {
  exists: async () => true,
  realpath: async (p) => p,
  readFile: async () => '',
  writeFile: async () => {},
  mkdir: async () => {},
  symlink: async () => {},
  lstat: async () => ({ isSymbolicLink: () => false }),
  stat: async () => ({ isDirectory: () => true }),
  readlink: async () => '',
  unlink: async () => {},
};

/// A spawned process a test can drive.
///
/// Output emitted before the supervisor has attached its handler is HELD and
/// replayed on attach, exactly as a real pipe holds bytes written before
/// anything reads them. Without that, a test racing the launch loses the line
/// it emitted and then waits forever for a readiness that can no longer
/// arrive — and how long the launch takes is not a test's business.
class FakeProc implements SpawnedProcess {
  pid = 4242;
  killed: NodeJS.Signals[] = [];
  private lineCb?: (line: string) => void;
  private exitCb?: (code: number | null) => void;
  private errorCb?: (err: Error) => void;
  private heldLines: string[] = [];
  private heldExit?: number | null;
  private heldError?: Error;
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? 'SIGTERM');
  }
  onLine(cb: (line: string) => void) {
    this.lineCb = cb;
    const held = this.heldLines;
    this.heldLines = [];
    for (const line of held) cb(line);
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCb = cb;
    if (this.heldExit !== undefined) {
      const code = this.heldExit;
      this.heldExit = undefined;
      cb(code);
    }
  }
  onError(cb: (err: Error) => void) {
    this.errorCb = cb;
    if (this.heldError) {
      const err = this.heldError;
      this.heldError = undefined;
      cb(err);
    }
  }
  emitLine(line: string) {
    if (this.lineCb) this.lineCb(line);
    else this.heldLines.push(line);
  }
  emitExit(code: number | null) {
    if (this.exitCb) this.exitCb(code);
    else this.heldExit = code;
  }
  emitError(err: Error) {
    if (this.errorCb) this.errorCb(err);
    else this.heldError = err;
  }
}

function harness(over: Partial<SupervisorDeps> = {}) {
  const spawns: SpawnRequest[] = [];
  const procs: FakeProc[] = [];
  let clock = 0;
  /// What a process should do the moment it is spawned — see `onSpawn`.
  let script: (proc: FakeProc) => void = () => {};
  const deps: SupervisorDeps = {
    spawn: (req) => {
      spawns.push(req);
      const proc = new FakeProc();
      procs.push(proc);
      // Before the supervisor attaches its handlers, so whatever this emits is
      // held by the process and replayed on attach — a service that prints its
      // ready line immediately, which is the case worth testing.
      script(proc);
      return proc;
    },
    probe: {
      httpStatus: async () => 200,
      tcpOpen: async () => true,
      exitCode: async () => 0,
      now: () => clock++,
      // Instant, so a test that drives the clock itself is not also waiting on
      // one. Safe only because `now` advances: a readiness wait is a loop of
      // `sleep` and a clock check, so with an instant sleep the clock is the
      // only thing that can end it.
      sleep: async () => {},
    },
    fs,
    configDir: (id) => `/cfg/${id}`,
    ...over,
  };
  /// Drive a service's output deterministically: what it prints or does the
  /// instant it starts, rather than racing the launch from outside it.
  const onSpawn = (fn: (proc: FakeProc) => void) => {
    script = fn;
  };
  return { deps, spawns, procs, onSpawn };
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

  it('masks start, output, status, and rebound writes before they reach the sink', async () => {
    const written: string[] = [];
    const secret = 'hunter2hunter2';
    const { deps, onSpawn } = harness({
      secretValues: () => [secret],
      logSink: { write: (_id, line) => written.push(line), close: async () => {} },
    });
    onSpawn((proc) => proc.emitLine(`output ${secret}`));
    const sup = new Supervisor(
      'mine',
      [spec({ id: 'api', command: ['run', secret] })],
      [binding('api')],
      deps,
    );

    await sup.start('api');
    (sup as unknown as { setStatus: (id: string, patch: object) => void }).setStatus('api', {
      status: 'failed',
      lastError: `failed ${secret}`,
    });
    (sup as unknown as { append: (id: string, line: string) => void }).append(
      'api',
      `── rebound to ${secret} ──`,
    );

    expect(written.some((line) => line.includes(secret))).toBe(false);
    expect(written.filter((line) => line.includes('••••••')).length).toBeGreaterThanOrEqual(4);
  });

  it('returns exactly the newest 20,000 lines after a 25,000-line burst', () => {
    const { deps } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    const append = (sup as unknown as { append: (id: string, line: string) => void }).append.bind(sup);

    for (let i = 0; i < 25_000; i++) append('api', `line ${i}`);

    expect(sup.log('api')).toHaveLength(20_000);
    expect(sup.log('api')[0]).toBe('line 5000');
    expect(sup.log('api').at(-1)).toBe('line 24999');
  });
});

describe('Supervisor unresolved machine values', () => {
  it('says the keychain would not open a stored secret instead of calling it missing', async () => {
    const { deps } = harness({
      machineValues: () => ({}),
      unreadableSecrets: () => ['DB_PASSWORD'],
    });
    const api = spec({
      id: 'api',
      options: [{ key: '-Ddb.password', value: '${DB_PASSWORD}' }, { key: '-Ddb.user', value: '${DB_USER}' }],
    });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);
    await sup.start('api');

    expect(sup.runtime('api').status).toBe('failed');
    expect(sup.runtime('api').lastError).toBe(
      "Keychain couldn't unlock: DB_PASSWORD. Re-enter it in machine values. Missing machine value: DB_USER",
    );
  });
});

describe('Supervisor login shell environment', () => {
  it('starts a service with the shell environment, under its own variables', async () => {
    const { deps, spawns } = harness({
      shellEnv: async () => ({ JAVA_HOME: '/sdk/jdk', OVERCLI_PORT: 'from-shell' }),
    });
    const sup = new Supervisor('mine', [spec({ id: 'api', port: 8080 })], [binding('api')], deps);
    await sup.start('api');

    expect(spawns[0].env.JAVA_HOME).toBe('/sdk/jdk');
    // What overcli sets for the service wins over anything the shell exported.
    expect(spawns[0].env.OVERCLI_PORT).toBe('8080');
  });

  it('starts all the same when the shell could not be read', async () => {
    const { deps, spawns } = harness({ shellEnv: async () => undefined });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');
    expect(spawns).toHaveLength(1);
  });
});

describe('Supervisor log cost per line', () => {
  // Every one of these guards a change that is invisible until a service gets
  // chatty: the pane keeps working, it just takes the main process with it.
  it('reads the secret store once for a whole run of output, not once per line', async () => {
    let reads = 0;
    const { deps, procs } = harness({
      secretValues: () => {
        reads += 1;
        return ['hunter2hunter2'];
      },
    });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');

    for (let i = 0; i < 500; i++) procs[0].emitLine(`line ${i} password=hunter2hunter2`);

    // One per run, not 500. Each read is a keychain round-trip per stored
    // secret, on the thread that paints every window.
    expect(reads).toBe(1);
    expect(sup.log('api').at(-1)).toBe('line 499 password=\u2022\u2022\u2022\u2022\u2022\u2022');
  });

  it('picks up an edited secret on the next line once the cache is dropped', async () => {
    let current = ['firstsecret'];
    const { deps, procs } = harness({ secretValues: () => [...current] });
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');

    procs[0].emitLine('using firstsecret');
    current = ['secondsecret'];
    procs[0].emitLine('still using secondsecret');
    // Not yet invalidated, so the new value is not masked.
    expect(sup.log('api').at(-1)).toBe('still using secondsecret');

    sup.clearSecretCache();
    procs[0].emitLine('now using secondsecret');
    expect(sup.log('api').at(-1)).toBe('now using \u2022\u2022\u2022\u2022\u2022\u2022');
  });

  it('holds the buffer at the cap without paying an O(cap) trim on every line', async () => {
    const { deps, procs } = harness();
    const sup = new Supervisor('mine', [spec({ id: 'api' })], [binding('api')], deps);
    await sup.start('api');

    // Comfortably past the cap and past one trim block, so both the batched
    // trim and the reader's slice are exercised.
    for (let i = 0; i < LOG_LIMIT + 2_500; i++) procs[0].emitLine(`line ${i}`);

    const lines = sup.log('api');
    expect(lines).toHaveLength(LOG_LIMIT);
    // The newest survive and the oldest are gone: trimming from the front.
    expect(lines.at(-1)).toBe(`line ${LOG_LIMIT + 2_499}`);
    expect(lines[0]).toBe(`line ${2_500}`);
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
    const gone: ProjectionFs = { ...fs, exists: async () => false };
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
    const { deps, onSpawn } = harness();
    const web = spec({ id: 'web', ready: { kind: 'log', pattern: 'Compiled successfully' } });
    const sup = new Supervisor('mine', [web], [binding('web')], deps);

    // The line comes from the process itself, as it does in life.
    onSpawn((proc) => proc.emitLine('✔ Compiled successfully.'));
    await sup.start('web');

    expect(sup.runtime('web').status).toBe('ready');
  });

  it('keeps the exit reason when a service dies on its way up', async () => {
    let clock = 0;
    const { deps, onSpawn } = harness({
      probe: {
        httpStatus: async () => {
          throw new Error('ECONNREFUSED');
        },
        tcpOpen: async () => false,
        exitCode: async () => 1,
        // Has to advance: a readiness wait gives up on elapsed time, and a
        // clock frozen at zero is a wait that can never time out.
        now: () => clock++,
        sleep: async () => {},
      },
    });
    const api = spec({ id: 'api', port: 8080, ready: { kind: 'tcp', port: 8080 } });
    const sup = new Supervisor('mine', [api], [binding('api')], deps);

    onSpawn((proc) => proc.emitExit(1));
    await sup.start('api');

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

    // After the start has resolved: node reports a spawn failure on the child
    // rather than throwing, so it lands on a service already believed to be up.
    await sup.start('api');
    procs[0].emitError(new Error('spawn ./mvnw ENOENT'));

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

  it('moves a service pinned to the ref it is being moved TO', async () => {
    // A pin holds a service to one ref; it is not a refusal to go there. This
    // was the shape that stuck: "switch to master and pin there" wrote the pin
    // and skipped the move, and running it again could never repair it —
    // the pin blocking the move was the one the move had just written.
    const { deps, spawns } = harness();
    const specs = [spec({ id: 'api', pinnedRef: 'master' })];
    const sup = new Supervisor('mine', specs, [binding('api', 'feat/x', '/wt/x')], deps);
    await sup.start('api');

    const moved = await sup.rebindAll([{ serviceId: 'api', ref: 'master', path: '/repos/main' }]);

    expect(moved).toEqual(['api']);
    expect(spawns.map((s) => s.cwd)).toEqual(['/wt/x', '/repos/main']);
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

  it('says so when the branch has moved on since the task published', async () => {
    // The invisible case: same branch, same green `done`, and a jar older than
    // the source next to it. Nothing but the commit tells them apart.
    let head = 'a'.repeat(40);
    const { deps, procs } = harness({ headOf: () => head });
    const specs = [
      spec({ id: 'api', projectId: 'common', deps: ['publish'] }),
      spec({ id: 'publish', name: 'common-publish', projectId: 'common', task: true }),
    ];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    const published = sup.start('publish');
    await settle();
    procs[0].emitExit(0);
    await published;
    expect(sup.runtime('publish').ranCommit).toBe('a'.repeat(40));

    head = 'b'.repeat(40);
    await sup.start('api');
    await settle();

    expect(sup.log('api')).toContain('── common-publish last ran from aaaaaaa; bbbbbbb is checked out now ──');
  });
});

describe('Supervisor.adopt', () => {
  /// The whole-stack answer the supervisor asks for: one map, all ports.
  const holding = (kind: PortHolderKind, port = 8080, pid = 4242) =>
    async () => new Map<number, PortOwner[]>([[port, [{ pid, command: 'java', kind }]]]);

  it('takes back a service whose leftover copy still holds its port', async () => {
    const { deps, spawns } = harness({ portOwners: holding('stale') });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.adopt();

    expect(sup.runtime('api').status).toBe('ready');
    expect(sup.runtime('api').adopted).toBe(true);
    expect(sup.runtime('api').pid).toBe(4242);
    // Nothing was launched: it is already running, which is the whole point.
    expect(spawns).toHaveLength(0);
    expect(sup.log('api').join('\n')).toMatch(/adopted · pid 4242/);
    // The port it holds is ours to defend now, or another stack takes it.
    expect(sup.claims().map((c) => c.port)).toEqual([8080]);
  });

  it('leaves someone else\'s process alone', async () => {
    // A terminal running the same service, or a database on that port. Both
    // classify as `other`, and neither is ours to claim or to kill.
    const { deps } = harness({ portOwners: holding('other') });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.adopt();

    expect(sup.runtime('api').status).toBe('stopped');
    expect(sup.runtime('api').adopted).toBeUndefined();
  });

  it('stops an adopted process through the port, having no child to signal', async () => {
    const freed: number[] = [];
    const { deps } = harness({
      portOwners: holding('stale'),
      stopHolder: async (port) => {
        freed.push(port);
      },
    });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.adopt();

    await sup.stop('api');

    expect(freed).toEqual([8080]);
    expect(sup.runtime('api').status).toBe('stopped');
    expect(sup.runtime('api').adopted).toBeUndefined();
  });

  it('restarts it into a process of our own, which is how the output comes back', async () => {
    // The leftover is gone once stopped, as it is in life — a fake that kept
    // reporting it would have the start adopt it straight back.
    let leftover = true;
    const { deps, spawns } = harness({
      portOwners: async (wanted) =>
        leftover ? holding('stale')() : new Map(wanted.map((w) => [w.port, [] as PortOwner[]])),
      stopProcess: async () => {
        leftover = false;
      },
    });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.adopt();

    await sup.restart('api');

    expect(spawns).toHaveLength(1);
    expect(sup.runtime('api').adopted).toBeUndefined();
  });

  it('asks once for the whole stack, not once per service', async () => {
    // The defect this replaced: a lookup per service is two `lsof`s and a `ps`
    // each, and a stack's worth started together time each other out against a
    // three-second budget. A timed-out lookup reports nothing listening, which
    // reads exactly like an idle port — so twenty-five running services were
    // adopted as none of them.
    const asked: number[][] = [];
    const { deps } = harness({
      portOwners: async (wanted) => {
        asked.push(wanted.map((w) => w.port));
        return new Map(wanted.map((w) => [
          w.port,
          [{ pid: 1000 + w.port, command: 'java', kind: 'stale' as PortHolderKind }],
        ]));
      },
    });
    const specs = [
      spec({ id: 'api', port: 8080 }),
      spec({ id: 'web', port: 4200 }),
      spec({ id: 'jobs', port: 9000 }),
    ];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.adopt();

    expect(asked).toEqual([[8080, 4200, 9000]]);
    expect(['api', 'web', 'jobs'].map((id) => sup.runtime(id).adopted)).toEqual([true, true, true]);
  });

  it('adopts a portless service instead of starting a second copy', async () => {
    // With no port there is no lease to refuse the start, and nothing
    // listening to find the first copy afterwards: two consumers would just
    // quietly share the work.
    const { deps, spawns } = harness({
      matchProcesses: async (targets) =>
        new Map(targets.map((t) => [t.serviceId, { pid: 777, command: 'run jobs', kind: 'stale' as PortHolderKind }])),
    });
    const specs = [spec({ id: 'jobs', port: undefined })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('jobs');

    expect(spawns).toHaveLength(0);
    expect(sup.runtime('jobs').adopted).toBe(true);
    expect(sup.runtime('jobs').pid).toBe(777);
    expect(sup.log('jobs').join('\n')).toMatch(/adopted rather than started a second time/);
  });

  it('starts beside a portless copy that is somebody else\'s, and says so', async () => {
    // Their own run in their own terminal. Refusing to start would be us
    // deciding; saying nothing would be us hiding it.
    const { deps, spawns } = harness({
      matchProcesses: async (targets) =>
        new Map(targets.map((t) => [t.serviceId, { pid: 778, command: 'run jobs', kind: 'other' as PortHolderKind }])),
    });
    const specs = [spec({ id: 'jobs', port: undefined })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('jobs');

    expect(spawns).toHaveLength(1);
    expect(sup.log('jobs').join('\n')).toMatch(/pid 778 is already running this from outside overcli/);
  });

  it('stops a portless adopted process by pid', async () => {
    const killed: number[] = [];
    const { deps } = harness({
      matchProcesses: async (targets) =>
        new Map(targets.map((t) => [t.serviceId, { pid: 779, command: 'run jobs', kind: 'stale' as PortHolderKind }])),
      stopProcess: async (pid) => {
        killed.push(pid);
      },
    });
    const specs = [spec({ id: 'jobs', port: undefined })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');

    await sup.stop('jobs');

    expect(killed).toEqual([779]);
    expect(sup.runtime('jobs').status).toBe('stopped');
  });

  it('adopts a leftover still booting, found by its command line before its port', async () => {
    // Started a minute before the app was reopened and not yet listening when
    // adoption scanned, so the port said nothing. The start must still find it
    // rather than launch into the port it is about to bind.
    const { deps, spawns } = harness({
      portOwners: async (wanted) => new Map(wanted.map((w) => [w.port, [] as PortOwner[]])),
      matchProcesses: async (targets) => new Map(targets.map((t) => [
        t.serviceId,
        { pid: 34128, root: 34056, command: 'java GradleWrapperMain :api:bootRun', kind: 'stale' as PortHolderKind },
      ])),
    });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('api');

    expect(spawns).toHaveLength(0);
    expect(sup.runtime('api').adopted).toBe(true);
    // The root: stopping it has to take the whole tree down.
    expect(sup.runtime('api').pid).toBe(34056);
  });

  it('does not adopt over something it is already running', async () => {
    // Nothing there when it starts; by the time adoption looks, the port is
    // held — by the copy we just launched, which must not be mistaken for a
    // leftover and taken over.
    let started = false;
    const { deps, spawns } = harness({
      portOwners: async (wanted) =>
        started ? holding('stale')() : new Map(wanted.map((w) => [w.port, [] as PortOwner[]])),
    });
    const specs = [spec({ id: 'api', port: 8080 })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('api');
    started = true;

    await sup.adopt();

    expect(spawns).toHaveLength(1);
    expect(sup.runtime('api').adopted).toBeUndefined();
  });
});

describe('adopting the right process', () => {
  // One checkout, two apps, both `npm run dev`. Admin's copy was left running
  // and orphaned; web has never been started.
  const mono = '/src/acme-mono';
  const table = async (command: string) => {
    if (command === 'ps') return ['  800   1 npm run dev', '  801 800 node vite'].join('\n');
    if (command === 'lsof') return ['p800', `n${mono}/apps/admin`, 'p801', `n${mono}/apps/admin`].join('\n');
    return null;
  };
  const stack = () => {
    const specs = [
      spec({ id: 'web', command: ['npm', 'run', 'dev'], subpath: 'apps/web' }),
      spec({ id: 'admin', command: ['npm', 'run', 'dev'], subpath: 'apps/admin' }),
    ];
    return { specs, bindings: specs.map((s) => binding(s.id, 'master', mono)) };
  };
  /// The real matcher over a fake process table, wired as the manager wires it.
  const realMatch: SupervisorDeps['matchProcesses'] = (targets) =>
    matchingProcesses(
      targets.map((t) => ({ key: t.serviceId, tokens: t.tokens, checkout: mono, subpath: t.subpath })),
      table,
      'darwin',
    );

  it("does not adopt another service's leftover", async () => {
    const stopped: number[] = [];
    const { deps, spawns } = harness({
      matchProcesses: realMatch,
      stopProcess: async (pid) => {
        stopped.push(pid);
      },
    });
    const { specs, bindings } = stack();
    const sup = new Supervisor('mine', specs, bindings, deps);

    await sup.start('web');

    expect(sup.runtime('web').adopted).toBeUndefined();
    expect(spawns.map((s) => s.cwd)).toEqual([`${mono}/apps/web`]);
    await sup.stop('web');
    // Stopping web is web's own child, never admin's tree.
    expect(stopped).toEqual([]);
  });

  it('still adopts that leftover for the service it belongs to', async () => {
    const { deps, spawns } = harness({ matchProcesses: realMatch });
    const { specs, bindings } = stack();
    const sup = new Supervisor('mine', specs, bindings, deps);

    await sup.start('admin');

    expect(spawns).toHaveLength(0);
    expect(sup.runtime('admin')).toMatchObject({ adopted: true, pid: 800 });
  });

  it('asks about every service in the stack, with its folder', async () => {
    const asked: { serviceId: string; subpath?: string }[][] = [];
    const { deps } = harness({
      matchProcesses: async (targets) => {
        asked.push(targets.map((t) => ({ serviceId: t.serviceId, subpath: t.subpath })));
        return new Map();
      },
    });
    const { specs, bindings } = stack();
    const sup = new Supervisor('mine', specs, bindings, deps);

    await sup.start('web');

    expect(asked).toEqual([[
      { serviceId: 'web', subpath: 'apps/web' },
      { serviceId: 'admin', subpath: 'apps/admin' },
    ]]);
  });

  it('passes the launch command with the port lookup', async () => {
    const asked: (readonly string[] | undefined)[] = [];
    const { deps } = harness({
      portOwners: async (wanted) => {
        asked.push(...wanted.map((w) => w.tokens));
        return new Map(wanted.map((w) => [w.port, [] as PortOwner[]]));
      },
    });
    const specs = [spec({ id: 'api', port: 8080, command: ['npm', 'start'] })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.adopt();

    expect(asked).toEqual([['npm', 'start']]);
  });
});

describe('an adopted pid', () => {
  const leftover = (pid = 779): SupervisorDeps['matchProcesses'] => async (targets) =>
    new Map(targets.map((t): [string, ProcessMatch] => [t.serviceId, { pid, command: 'run jobs', kind: 'stale' }]));

  it('is not signalled once the OS has handed it to something else', async () => {
    const killed: number[] = [];
    let started = 'Tue Sep 22 10:00:00 2026';
    const { deps } = harness({
      matchProcesses: leftover(),
      processStarted: async () => started,
      stopProcess: async (pid) => {
        killed.push(pid);
      },
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');
    expect(sup.runtime('jobs').adopted).toBe(true);

    // The leftover exited and pid 779 now belongs to something started later.
    started = 'Tue Sep 22 11:30:00 2026';
    await sup.stop('jobs');

    expect(killed).toEqual([]);
    expect(sup.runtime('jobs')).toMatchObject({ status: 'stopped', adopted: undefined, pid: undefined });
    expect(sup.log('jobs').join('\n')).toMatch(/pid 779 is no longer the adopted process.*left alone/);
  });

  it('is not signalled on restart either, and the restart launches a copy of our own', async () => {
    const killed: number[] = [];
    let started = 'Tue Sep 22 10:00:00 2026';
    const { deps, spawns } = harness({
      matchProcesses: leftover(),
      processStarted: async () => started,
      stopProcess: async (pid) => {
        killed.push(pid);
      },
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');

    started = 'Tue Sep 22 11:30:00 2026';
    await sup.restart('jobs');

    expect(killed).toEqual([]);
    expect(spawns).toHaveLength(1);
    expect(sup.runtime('jobs').adopted).toBeUndefined();
  });

  it('is still stopped, tree and all, while it is the same process', async () => {
    const killed: number[] = [];
    const { deps } = harness({
      matchProcesses: leftover(),
      processStarted: async () => 'Tue Sep 22 10:00:00 2026',
      stopProcess: async (pid) => {
        killed.push(pid);
      },
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');

    await sup.stop('jobs');

    expect(killed).toEqual([779]);
  });

  it('goes to stopped when the process exits, found by polling', async () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const { deps } = harness({
        matchProcesses: leftover(),
        processStarted: async () => (alive ? 'Tue Sep 22 10:00:00 2026' : null),
      });
      const specs = [spec({ id: 'jobs' })];
      const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
      await sup.start('jobs');

      await vi.advanceTimersByTimeAsync(ADOPTED_POLL_MS);
      expect(sup.runtime('jobs').status).toBe('ready');

      alive = false;
      await vi.advanceTimersByTimeAsync(ADOPTED_POLL_MS);

      expect(sup.runtime('jobs')).toMatchObject({ status: 'stopped', adopted: undefined, pid: undefined });
      expect(sup.log('jobs').join('\n')).toMatch(/adopted process, pid 779, has exited/);
      // Nothing left to poll: the timer is not re-armed for a row that is gone.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not trusted as ready by a dependent once it has gone', async () => {
    let alive = true;
    const { deps, spawns } = harness({
      matchProcesses: async (targets) => new Map(
        alive
          ? targets.filter((t) => t.serviceId === 'api')
            .map((t): [string, ProcessMatch] => [t.serviceId, { pid: 700, command: 'run api', kind: 'stale' }])
          : [],
      ),
      processStarted: async () => (alive ? 'Tue Sep 22 10:00:00 2026' : null),
    });
    const specs = [spec({ id: 'api' }), spec({ id: 'web', deps: ['api'] })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('api');
    expect(sup.runtime('api').adopted).toBe(true);

    alive = false;
    await sup.start('web');

    // The dependency was brought up for real rather than waved through.
    expect(spawns.map((s) => s.command[1])).toEqual(['api', 'web']);
    expect(sup.runtime('api').adopted).toBeUndefined();
  });

  it('is not adopted when it is gone by the time it is looked at', async () => {
    const { deps, spawns } = harness({
      matchProcesses: leftover(),
      processStarted: async () => null,
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);

    await sup.start('jobs');

    expect(sup.runtime('jobs').adopted).toBeUndefined();
    expect(spawns).toHaveLength(1);
  });
});

describe('a restart does not adopt what it just stopped', () => {
  it('launches fresh even when a dying child looks like a leftover', async () => {
    // Stopping our own copy leaves a child still shutting down, reparented to
    // launchd — which classifies stale. Adopting it marked the row ready a
    // moment before it exited.
    let running = false;
    let asked = 0;
    const { deps, spawns } = harness({
      matchProcesses: async (targets) => {
        asked++;
        return new Map(running
          ? targets.map((t): [string, ProcessMatch] => [t.serviceId, { pid: 991, command: 'run jobs', kind: 'stale' }])
          : []);
      },
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');
    running = true;
    asked = 0;

    await sup.restart('jobs');

    expect(spawns).toHaveLength(2);
    expect(sup.runtime('jobs').adopted).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('nor does a rebind of something that was running', async () => {
    let running = false;
    const { deps, spawns } = harness({
      matchProcesses: async (targets) => new Map(running
        ? targets.map((t): [string, ProcessMatch] => [t.serviceId, { pid: 992, command: 'run jobs', kind: 'stale' }])
        : []),
    });
    const specs = [spec({ id: 'jobs' })];
    const sup = new Supervisor('mine', specs, specs.map((s) => binding(s.id)), deps);
    await sup.start('jobs');
    running = true;

    await sup.rebind('jobs', { ref: 'feature/x', path: '/repos/feature-x' });

    expect(spawns).toHaveLength(2);
    expect(sup.runtime('jobs').adopted).toBeUndefined();
  });
});

describe('task drift notes', () => {
  it('reads the head of only the checkouts the comparison uses', async () => {
    const heads: string[] = [];
    const { deps } = harness({
      headOf: (checkout) => {
        heads.push(checkout);
        return 'abc123';
      },
    });
    const specs = [
      spec({ id: 'publish', task: true }),
      spec({ id: 'api', deps: ['publish'] }),
      spec({ id: 'web' }),
      spec({ id: 'docs' }),
    ];
    const bindings = [
      binding('publish', 'master', '/repos/lib'),
      binding('api', 'master', '/repos/api'),
      binding('web', 'master', '/repos/web'),
      binding('docs', 'master', '/repos/docs'),
    ];
    const sup = new Supervisor('mine', specs, bindings, deps, { publish: { ref: 'master', at: 1 } });

    await sup.start('api');

    expect(new Set(heads)).toEqual(new Set(['/repos/lib', '/repos/api']));
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

describe('Supervisor launch gate', () => {
  const jvm = (id: string, port: number) =>
    spec({ id, runner: 'gradle', command: ['./gradlew', `:${id}:bootRun`], port, ready: { kind: 'tcp', port } });

  function gated(limit = 1) {
    const open = new Set<number>();
    const h = harness({
      launchGate: new LaunchGate(limit),
      probe: {
        httpStatus: async () => 200,
        tcpOpen: async (port) => open.has(port),
        exitCode: async () => 0,
        now: () => Date.now(),
        // A real turn of the event loop, so the test gets to act between polls.
        sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
      },
    });
    return { ...h, open };
  }

  it('queues a JVM build behind one still starting, then starts it once that one is up', async () => {
    const { deps, spawns, open } = gated();
    const sup = new Supervisor('mine', [jvm('a', 5001), jvm('b', 5002)], [binding('a'), binding('b')], deps);

    void sup.start('a');
    void sup.start('b');
    await vi.waitFor(() => expect(sup.runtime('b').queued).toBe(true));
    expect(spawns).toHaveLength(1);

    open.add(5001);
    await vi.waitFor(() => expect(spawns).toHaveLength(2));
    expect(sup.runtime('b').queued).toBeUndefined();
    expect(sup.runtime('b').status).toBe('starting');
  });

  it('gives the turn up when the build exits', async () => {
    const { deps, spawns, procs } = gated();
    const sup = new Supervisor('mine', [jvm('a', 5001), jvm('b', 5002)], [binding('a'), binding('b')], deps);

    void sup.start('a');
    void sup.start('b');
    await vi.waitFor(() => expect(sup.runtime('b').queued).toBe(true));
    procs[0].emitExit(1);
    await vi.waitFor(() => expect(spawns).toHaveLength(2));
  });

  it('calls off a queued start when it is stopped', async () => {
    const { deps, spawns, open } = gated();
    const sup = new Supervisor('mine', [jvm('a', 5001), jvm('b', 5002)], [binding('a'), binding('b')], deps);

    void sup.start('a');
    void sup.start('b');
    await vi.waitFor(() => expect(sup.runtime('b').queued).toBe(true));
    await sup.stop('b');
    expect(sup.runtime('b').status).toBe('stopped');

    open.add(5001);
    await vi.waitFor(() => expect(sup.runtime('a').status).toBe('ready'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawns).toHaveLength(1);
  });

  it('lets anything that is not a JVM build straight past', async () => {
    const { deps, spawns } = gated();
    const sup = new Supervisor(
      'mine',
      [jvm('a', 5001), spec({ id: 'web', runner: 'vite', command: ['npm', 'run', 'dev'] })],
      [binding('a'), binding('web')],
      deps,
    );

    void sup.start('a');
    await sup.start('web');
    expect(spawns).toHaveLength(2);
  });
});
