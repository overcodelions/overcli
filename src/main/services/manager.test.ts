import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServicesManager, fsRepoReader } from './manager';
import { loadStack, saveStack } from './store';
import type { ServiceSpec } from './types';

let dataDir: string;
let repo: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-mgr-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-repo-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function manager() {
  const events: unknown[] = [];
  return { mgr: new ServicesManager(dataDir, (e) => events.push(e)), events };
}

const spec: ServiceSpec = {
  id: 'api',
  name: 'billing-rest',
  runner: 'command',
  command: ['true'],
  port: 8080,
  ready: { kind: 'none' },
  selfReloads: false,
  config: {},
};

/// Stands in for the keychain: reversible, and visibly not the plain text.
const fakeCipher = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^enc:/, ''),
};

describe('ServicesManager machine values', () => {
  const secretsFile = () => path.join(dataDir, 'services', 'machine-secrets.json');
  const plainFile = () => path.join(dataDir, 'services', 'machine.json');

  it('keeps secrets out of the plain file and out of what the pane sees', () => {
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    mgr.saveMachineValues([
      { name: 'DB_PASSWORD', secret: true, value: 'hunter2hunter2' },
      { name: 'SQS_PREFIX', secret: false, value: 'lionel' },
    ]);

    expect(fs.readFileSync(plainFile(), 'utf8')).not.toContain('hunter2');
    expect(fs.readFileSync(secretsFile(), 'utf8')).not.toContain('hunter2');
    expect(mgr.machineValues()).toEqual({
      entries: [
        { name: 'DB_PASSWORD', secret: true, stored: true },
        { name: 'SQS_PREFIX', secret: false, value: 'lionel' },
      ],
      secureStorage: true,
    });
  });

  it('keeps a stored secret when it comes back without a value', () => {
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    mgr.saveMachineValues([{ name: 'API_TOKEN', secret: true, value: 'abcdefgh1234' }]);
    mgr.saveMachineValues([{ name: 'API_TOKEN', secret: false }]);
    expect(mgr.machineValues().entries).toEqual([{ name: 'API_TOKEN', secret: true, stored: true }]);
  });

  it('moves credentials saved before encryption out of the plain file', () => {
    fs.mkdirSync(path.join(dataDir, 'services'), { recursive: true });
    fs.writeFileSync(
      plainFile(),
      JSON.stringify({
        // A real AWS secret key can start with a slash; only a path that
        // exists is left in plain text.
        AWS_SECRETKEY: '/ytENUo9lfzO2JoZpz/4EJApVJI',
        SSH_KEY_PATH: repo,
        REGION: 'us-east-1',
      }),
    );
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    expect(mgr.machineValues().entries.map((e) => [e.name, e.secret])).toEqual([
      ['AWS_SECRETKEY', true],
      ['REGION', false],
      ['SSH_KEY_PATH', false],
    ]);
    expect(fs.readFileSync(plainFile(), 'utf8')).not.toContain('ytENUo9');
  });

  it('refuses to store a secret without a keychain rather than writing it in plain text', () => {
    const mgr = new ServicesManager(dataDir, () => {});
    expect(() =>
      mgr.saveMachineValues([{ name: 'DB_PASSWORD', secret: true, value: 'hunter2hunter2' }]),
    ).toThrow(/no keychain/);
    expect(fs.existsSync(plainFile())).toBe(false);
  });

  it('lists the values services refer to that are not set, and who needs them', () => {
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    mgr.saveMachineValues([{ name: 'DB_USER', secret: false, value: 'root' }]);
    mgr.addService(
      'ws1',
      {
        ...spec,
        options: [
          { key: '-Ddatabase.userid', value: '${DB_USER}' },
          { key: '-Ddatabase.password', value: '${DB_PASSWORD}' },
        ],
        config: { inject: { CONFIG: '${SERVICE_CONFIG_DIR}/app.yml', TOKEN: '${API_TOKEN}' } },
      },
      { ref: 'master', path: repo },
    );
    expect(mgr.machineValueNeeds(['ws1'])).toEqual([
      { name: 'API_TOKEN', services: ['billing-rest'] },
      { name: 'DB_PASSWORD', services: ['billing-rest'] },
    ]);
  });

  it('masks secrets in the resolved options sent to the pane', () => {
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    mgr.saveMachineValues([{ name: 'DB_PASSWORD', secret: true, value: 'hunter2hunter2' }]);
    mgr.addService(
      'ws1',
      { ...spec, options: [{ key: '-Ddb.password', value: '${DB_PASSWORD}' }] },
      { ref: 'master', path: repo },
    );
    expect(mgr.resolvedOptions('ws1', 'api')[0].value).toBe('••••••');
  });
});

describe('ServicesManager stack editing', () => {
  it('persists a service and reads it back on a fresh manager', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });

    const reloaded = new ServicesManager(dataDir, () => {});
    expect(reloaded.view('ws1').services).toEqual([spec]);
    expect(reloaded.view('ws1').bindings[0].path).toBe(repo);
  });

  it('reports every service as stopped before anything is started', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    expect(mgr.view('ws1').runtimes).toEqual([{ serviceId: 'api', status: 'stopped' }]);
  });

  it('removes a service and its binding together', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    mgr.removeService('ws1', 'api');
    expect(loadStack(dataDir, 'ws1')).toEqual({ workspaceId: 'ws1', services: [], bindings: [] });
  });

  it('removes several at once and puts them back where they were', () => {
    const { mgr } = manager();
    for (const id of ['a', 'b', 'c', 'd']) {
      mgr.addService('ws1', { ...spec, id, name: id }, { ref: 'master', path: repo });
    }

    const removed = mgr.removeServices('ws1', ['b', 'd']);
    expect(mgr.view('ws1').services.map((s) => s.id)).toEqual(['a', 'c']);
    expect(removed.services.map((r) => [r.spec.id, r.index])).toEqual([['b', 1], ['d', 3]]);

    mgr.restoreServices('ws1', removed);
    expect(mgr.view('ws1').services.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(mgr.view('ws1').bindings.map((b) => b.serviceId).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps what "ready" means and how long it may take', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    mgr.setReady('ws1', 'api', { kind: 'log', pattern: 'Started .* in' }, 240);

    const reloaded = new ServicesManager(dataDir, () => {});
    expect(reloaded.view('ws1').services[0]).toMatchObject({
      ready: { kind: 'log', pattern: 'Started .* in' },
      readyTimeoutSec: 240,
    });
  });

  it('persists restart-on-change mode and keeps its globs inside the checkout', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });

    mgr.setWatch('ws1', 'api', false, [' src/** ', '../outside/**', 'src/**']);
    expect(new ServicesManager(dataDir, () => {}).view('ws1').services[0]).toMatchObject({
      selfReloads: false,
      watch: ['src/**'],
    });

    mgr.setWatch('ws1', 'api', true, ['ignored/**']);
    expect(mgr.view('ws1').services[0]).toMatchObject({ selfReloads: true });
    expect(mgr.view('ws1').services[0].watch).toBeUndefined();
  });

  it('pins and unpins a service', () => {
    // "Pin the backends, float the frontend" is one flag per service.
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    mgr.setPinned('ws1', 'api', 'master');
    expect(mgr.view('ws1').services[0].pinnedRef).toBe('master');
    mgr.setPinned('ws1', 'api', undefined);
    expect(mgr.view('ws1').services[0].pinnedRef).toBeUndefined();
  });

  it('keeps a rebind out of the stacks it does not belong to', () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    mgr.addService('ws2', { ...spec, id: 'other' }, { ref: 'master', path: repo });
    expect(mgr.view('ws2').services.map((s) => s.id)).toEqual(['other']);
  });
});

describe('ServicesManager.rebind', () => {
  it('persists the new binding so it survives a restart of the app', async () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });

    await mgr.rebind('ws1', 'api', { ref: 'feat/x', path: repo });

    expect(loadStack(dataDir, 'ws1').bindings[0]).toEqual({
      serviceId: 'api',
      ref: 'feat/x',
      path: repo,
    });
  });

  it('moves everything unpinned and leaves the pinned alone', async () => {
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    mgr.addService('ws1', { ...spec, id: 'security', port: 8085, pinnedRef: 'master' }, {
      ref: 'master',
      path: repo,
    });

    const moved = await mgr.rebindAll('ws1', [
      { serviceId: 'api', ref: 'feat/x', path: repo },
      { serviceId: 'security', ref: 'feat/x', path: repo },
    ]);

    expect(moved).toEqual(['api']);
    const bindings = loadStack(dataDir, 'ws1').bindings;
    expect(bindings.find((b) => b.serviceId === 'security')?.ref).toBe('master');
  });
});

describe('ServicesManager.scan', () => {
  it('proposes a service with the evidence it came from', () => {
    fs.writeFileSync(
      path.join(repo, 'pom.xml'),
      '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build><dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency></project>',
    );
    fs.mkdirSync(path.join(repo, 'src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/main/resources/application.yml'), 'server:\n  port: 8084\n');

    const { mgr } = manager();
    const found = mgr.scan([{ id: 'p1', name: 'billing-rest', path: repo }]);

    expect(found).toHaveLength(1);
    expect(found[0].proposal.spec.port).toBe(8084);
    expect(found[0].serviceId).toBe('p1-billing-rest');
    expect(found[0].proposal.evidence.some((e) => e.source?.includes('application.yml'))).toBe(true);
  });

  it('adds nothing by scanning — a proposal is not a decision', () => {
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project>spring-boot-maven-plugin</project>');
    const { mgr } = manager();
    mgr.scan([{ id: 'p1', name: 'svc', path: repo }]);
    expect(mgr.view('ws1').services).toEqual([]);
  });

  it('skips a checkout it does not recognise', () => {
    const { mgr } = manager();
    expect(mgr.scan([{ id: 'p1', name: 'docs', path: repo }])).toEqual([]);
  });
});

describe('fsRepoReader', () => {
  it('reads a file and reports a missing one as null', () => {
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module x');
    const reader = fsRepoReader(repo);
    expect(reader.exists('go.mod')).toBe(true);
    expect(reader.read('go.mod')).toBe('module x');
    expect(reader.read('nope.txt')).toBeNull();
  });
});

describe('choosing where a service runs', () => {
  function gitRepo(): void {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-b', 'master');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README'), 'hi\n');
    git('add', '.');
    git('commit', '-m', 'first');
    git('branch', 'feature/x');
  }

  it('lists the branches that do not have a checkout of their own', async () => {
    gitRepo();
    const { mgr } = manager();
    const refs = await mgr.refsFor(repo);
    expect(refs.worktrees.map((w) => w.ref)).toEqual(['master']);
    // `master` has a checkout, so it belongs in the other list.
    expect(refs.branches.map((b) => b.ref).sort()).toEqual(['feature/x', 'master']);
    expect(refs.defaultBranch).toBe('master');
  });

  it('checks a branch out and follows it with the binding', async () => {
    gitRepo();
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });

    expect(await mgr.checkoutRef('ws1', 'api', 'feature/x')).toEqual({ ok: true });
    expect(mgr.view('ws1').bindings[0].ref).toBe('feature/x');
  });

  it('reuses a checkout\'s branch for a few seconds rather than shelling out per look', async () => {
    // `view` runs on every look at the pane, on every service event it
    // refreshes on, and on every `@` typed in the composer. Reading the ref
    // meant a synchronous `git rev-parse` per service folder on the main
    // process each time, which is the pause before the mention menu draws.
    gitRepo();
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });
    expect(mgr.view('ws1').bindings[0].ref).toBe('master');

    execFileSync('git', ['checkout', '-q', 'feature/x'], { cwd: repo, stdio: 'ignore' });
    expect(mgr.view('ws1').bindings[0].ref).toBe('master');

    // A branch someone moves in a terminal is still picked up — just not more
    // often than a human could move it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      expect(mgr.view('ws1').bindings[0].ref).toBe('feature/x');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to check out over uncommitted work', async () => {
    // Discarding somebody's changes to start a service is never a trade this
    // app gets to make on its own — and the tree it would discard them in may
    // be one a flow is running in.
    gitRepo();
    fs.writeFileSync(path.join(repo, 'README'), 'edited\n');
    const { mgr } = manager();
    mgr.addService('ws1', spec, { ref: 'master', path: repo });

    const outcome = await mgr.checkoutRef('ws1', 'api', 'feature/x');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('uncommitted');
  });

  it('says so when the service is not bound anywhere', async () => {
    const { mgr } = manager();
    const outcome = await mgr.checkoutRef('ws1', 'ghost', 'master');
    expect(outcome).toEqual({ ok: false, reason: 'That service is not bound to a checkout.' });
  });
});

describe('repairing services saved by older versions', () => {
  it('turns the Gradle daemon off for a bootRun saved before that was the default', () => {
    // With the daemon on, the JVM keeps the environment of whichever launch
    // started the daemon — SPRING_PROFILES_ACTIVE=local never arrives, and
    // the process comes up on "slave".
    saveStack(dataDir, {
      workspaceId: 'ws1',
      services: [{ ...spec, runner: 'gradle', command: ['./gradlew', ':AcmeProcessor:bootRun'] }],
      bindings: [],
    });
    const { mgr } = manager();
    expect(mgr.view('ws1').services[0].command).toEqual([
      './gradlew',
      ':AcmeProcessor:bootRun',
      '-Dorg.gradle.daemon=false',
    ]);
    // And keeps it, so the repair happens once.
    expect(loadStack(dataDir, 'ws1').services[0].command).toContain('-Dorg.gradle.daemon=false');
  });

  it('leaves a non-Gradle command alone', () => {
    saveStack(dataDir, { workspaceId: 'ws1', services: [spec], bindings: [] });
    const { mgr } = manager();
    expect(mgr.view('ws1').services[0].command).toEqual(['true']);
  });

  it('drops the module directory off a Gradle service that could never start there', () => {
    // `spawn ./gradlew ENOENT`: imported from a run configuration that named
    // the module as its working directory, where there is no wrapper.
    saveStack(dataDir, {
      workspaceId: 'ws1',
      services: [
        {
          ...spec,
          runner: 'gradle',
          subpath: 'AcmeProcessor',
          command: ['./gradlew', ':AcmeProcessor:bootRun', '-Dorg.gradle.daemon=false'],
        },
      ],
      bindings: [],
    });
    const { mgr } = manager();
    expect(mgr.view('ws1').services[0].subpath).toBeUndefined();
    // And keeps it, so the repair happens once.
    expect(loadStack(dataDir, 'ws1').services[0].subpath).toBeUndefined();
  });

  it('repairs a Gradle service that builds before it runs', () => {
    saveStack(dataDir, {
      workspaceId: 'ws1',
      services: [
        {
          ...spec,
          runner: 'gradle',
          subpath: 'schema-updater',
          command: ['sh', '-c', './gradlew :schema-updater:build && java -jar build/libs/app.jar'],
        },
      ],
      bindings: [],
    });
    const { mgr } = manager();
    expect(mgr.view('ws1').services[0].subpath).toBeUndefined();
  });

  it('leaves a subpath alone when the wrapper is not what runs', () => {
    // A module started by something other than the root wrapper runs where it
    // lives, and taking its directory away would break it.
    saveStack(dataDir, {
      workspaceId: 'ws1',
      services: [{ ...spec, runner: 'gradle', subpath: 'tooling', command: ['gradle', 'bootRun'] }],
      bindings: [],
    });
    const { mgr } = manager();
    expect(mgr.view('ws1').services[0].subpath).toBe('tooling');
  });
});

describe('a service with nothing to run', () => {
  it('fails with a reason instead of throwing out of start', async () => {
    // spawn() throws synchronously on an undefined program, and that used to
    // escape the IPC handler as a stack trace in the dev terminal.
    const { mgr } = manager();
    mgr.addService(
      'ws1',
      { ...spec, id: 'empty', name: 'content-svc', command: [], port: undefined },
      { ref: 'master', path: repo },
    );

    // Resolving at all is the point — this used to throw.
    await mgr.start('ws1', 'empty');
    const runtime = mgr.view('ws1').runtimes.find((r) => r.serviceId === 'empty');
    expect(runtime?.status).toBe('failed');
    expect(runtime?.lastError).toContain('no command');
  });
});

describe('importing services that live in another project', () => {
  // The acme-local-dev shape: the Tiltfile is in one repo, and the module
  // it names is in another. Detection used to look only beside the Tiltfile,
  // find nothing, and save the service with an empty command.
  function siblingRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-sibling-'));
    fs.writeFileSync(path.join(dir, 'gradlew'), '#!/bin/sh\n');
    fs.writeFileSync(
      path.join(dir, 'build.gradle'),
      "plugins { id 'org.springframework.boot' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n",
    );
    fs.mkdirSync(path.join(dir, 'src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/main/resources/application.yml'), 'server:\n  port: 5024\n');
    return dir;
  }

  it('finds the module in a sibling project and binds the service there', () => {
    const sibling = siblingRepo();
    try {
      const { mgr } = manager();
      const outcome = mgr.importServices('ws1', {
        projectId: 'tilt',
        projectPath: repo,
        projectName: 'acme-local-dev',
        services: [
          { name: 'content-svc', moduleHint: 'content-service', port: 5024, options: [], env: {}, source: 'tiltfile' },
        ],
        siblings: [{ id: 'content', name: 'content-service', path: sibling }],
      });

      expect(outcome.skipped).toEqual([]);
      expect(outcome.added).toHaveLength(1);
      const view = mgr.view('ws1');
      expect(view.services[0].command.length).toBeGreaterThan(0);
      expect(view.services[0].projectId).toBe('content');
      expect(view.bindings[0].path).toBe(sibling);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('reports what nothing can start instead of saving it broken', () => {
    const { mgr } = manager();
    const outcome = mgr.importServices('ws1', {
      projectId: 'tilt',
      projectPath: repo,
      projectName: 'acme-local-dev',
      services: [
        { name: 'ghost-svc', moduleHint: 'nowhere-service', options: [], env: {}, source: 'tiltfile' },
      ],
      siblings: [],
    });

    expect(outcome).toMatchObject({
      added: [],
      skipped: [{ name: 'ghost-svc', reason: 'nothing says where it lives or how to start it' }],
    });
    expect(mgr.view('ws1').services).toEqual([]);
  });

  it('names the repo when the one a Tiltfile points at is not in the workspace', () => {
    const { mgr } = manager();
    const outcome = mgr.importServices('ws1', {
      projectId: 'tilt',
      projectPath: repo,
      projectName: 'acme-local-dev',
      services: [{ name: 'agent', repoHint: 'bedrock-agent', options: [], env: {}, source: 'tiltfile' }],
      siblings: [],
    });

    expect(outcome.skipped).toEqual([
      { name: 'agent', reason: 'bedrock-agent is not a project in this workspace' },
    ]);
  });

  it('falls back to the Tiltfile helper command when nothing is detected', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-portal-'));
    try {
      const { mgr } = manager();
      const tail = ['sh', '-c', 'exec tail -F /var/log/apache2/error_log'];
      const outcome = mgr.importServices('ws1', {
        projectId: 'tilt',
        projectPath: repo,
        projectName: 'acme-local-dev',
        services: [
          {
            name: 'legacy-portal',
            repoHint: path.basename(home),
            helperCommand: tail,
            options: [],
            env: {},
            source: 'tiltfile',
          },
        ],
        siblings: [{ id: 'acme-portal', name: 'legacy-portal', path: home }],
      });

      expect(outcome.needsCommand).toEqual([]);
      expect(mgr.view('ws1').services[0].command).toEqual(tail);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('adds what it knows the home of but not the command, bound there', () => {
    // legacy-portal: the Tiltfile names the repo, but what it runs is Apache, and
    // nothing in the repo is detectable. Recreating it by hand was the only way
    // out; now only the command is left to type.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-portal-'));
    try {
      const { mgr } = manager();
      const outcome = mgr.importServices('ws1', {
        projectId: 'tilt',
        projectPath: repo,
        projectName: 'acme-local-dev',
        services: [
          { name: 'legacy-portal', repoHint: path.basename(home), options: [], env: {}, source: 'tiltfile' },
        ],
        siblings: [{ id: 'acme-portal', name: 'legacy-portal', path: home }],
      });

      expect(outcome.skipped).toEqual([]);
      expect(outcome.needsCommand).toEqual(['legacy-portal']);
      const view = mgr.view('ws1');
      expect(view.services[0]).toMatchObject({ name: 'legacy-portal', projectId: 'acme-portal', command: [] });
      expect(view.bindings[0].path).toBe(home);

      mgr.setCommand('ws1', view.services[0].id, ['sh', '-c', 'tail -F /var/log/apache2/error_log']);
      expect(mgr.view('ws1').services[0].command[0]).toBe('sh');

      // Importing again keeps what was typed rather than wiping it.
      mgr.importServices('ws1', {
        projectId: 'tilt',
        projectPath: repo,
        projectName: 'acme-local-dev',
        services: [
          { name: 'legacy-portal', repoHint: path.basename(home), options: [], env: {}, source: 'tiltfile' },
        ],
        siblings: [{ id: 'acme-portal', name: 'legacy-portal', path: home }],
      });
      expect(mgr.view('ws1').services).toHaveLength(1);
      expect(mgr.view('ws1').services[0].command).toEqual([
        'sh',
        '-c',
        'tail -F /var/log/apache2/error_log',
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('importing a run configuration for a Gradle module', () => {
  /// A multi-module build: the wrapper is at the root and each module is a
  /// directory under it, which is the shape an IntelliJ run config describes
  /// by naming the module directory as its working directory.
  function gradleRoot(): void {
    fs.writeFileSync(path.join(repo, 'gradlew'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(repo, 'settings.gradle'), "include ':content-service'\n");
    fs.mkdirSync(path.join(repo, 'content-service/src/main/resources'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'content-service/build.gradle'),
      "plugins { id 'org.springframework.boot' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n",
    );
    fs.writeFileSync(path.join(repo, 'content-service/src/main/resources/application.yml'), 'server:\n  port: 5024\n');
  }

  const runConfig = (over: Record<string, unknown> = {}) => ({
    name: 'ContentAdmin',
    moduleHint: 'content-service',
    // What IntelliJ called the working directory: the module, not the root.
    subpath: 'content-service',
    options: [],
    env: {},
    source: 'intellij' as const,
    ...over,
  });

  it('runs the detected wrapper from the repo root, not the module directory', () => {
    // `spawn ./gradlew ENOENT`: the wrapper is at the root, so a service that
    // inherited the run config's module directory could never start.
    gradleRoot();
    const { mgr } = manager();
    const outcome = mgr.importServices('ws1', {
      projectId: 'p1',
      projectPath: repo,
      projectName: 'acme-platform',
      services: [runConfig()],
      siblings: [],
    });

    expect(outcome.skipped).toEqual([]);
    const service = mgr.view('ws1').services[0];
    expect(service.command[0]).toBe('./gradlew');
    expect(service.subpath).toBeUndefined();
  });

  it('keeps the run config directory when the command is the file own', () => {
    // Nothing detected the command, so nothing knows better than the file
    // about where it runs.
    gradleRoot();
    const { mgr } = manager();
    mgr.importServices('ws1', {
      projectId: 'p1',
      projectPath: repo,
      projectName: 'acme-platform',
      services: [runConfig({ command: ['sh', '-c', 'exec ./run-local.sh'] })],
      siblings: [],
    });

    expect(mgr.view('ws1').services[0].subpath).toBe('content-service');
  });

  it('lifts the credentials of a single configuration, which shares nothing', () => {
    // Factoring finds nothing in common in a group of one, so the options
    // used to go to disk exactly as IntelliJ held them: passwords included.
    gradleRoot();
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    const outcome = mgr.importServices('ws1', {
      projectId: 'p1',
      projectPath: repo,
      projectName: 'acme-platform',
      services: [
        runConfig({
          options: [
            { key: '-Ddatabase.password', value: 'hunter2hunter2' },
            { key: '-Daws.secretKey', value: '/ytENUo9lfzO2JoZpz' },
            { key: '-Xmx1024m' },
          ],
        }),
      ],
      siblings: [],
    });

    expect(outcome.lifted).toEqual(['DATABASE_PASSWORD', 'AWS_SECRETKEY']);
    expect(mgr.view('ws1').services[0].options).toEqual([
      { key: '-Ddatabase.password', value: '${DATABASE_PASSWORD}' },
      { key: '-Daws.secretKey', value: '${AWS_SECRETKEY}' },
      { key: '-Xmx1024m' },
    ]);
    expect(JSON.stringify(loadStack(dataDir, 'ws1'))).not.toContain('hunter2');
  });

  it('lifts a credential that only one of several configurations sets', () => {
    // Factored out as the difference between the two configurations, which is
    // exactly the half that was never scanned.
    gradleRoot();
    const mgr = new ServicesManager(dataDir, () => {}, [], fakeCipher);
    const withPassword = (name: string, value: string) =>
      runConfig({
        name,
        options: [
          { key: '-Ddatabase.password', value: 'shared-one' },
          { key: '-Dmart.database.password', value },
        ],
      });
    const outcome = mgr.importServices('ws1', {
      projectId: 'p1',
      projectPath: repo,
      projectName: 'acme-platform',
      services: [withPassword('ContentAdmin', 'mart-one'), withPassword('ContentBatch', 'mart-two')],
      siblings: [],
    });

    // One name each: collapsing them would start one service on the other's
    // credentials.
    expect(outcome.lifted).toEqual([
      'DATABASE_PASSWORD',
      'MART_DATABASE_PASSWORD',
      'MART_DATABASE_PASSWORD_2',
    ]);
    const copies = mgr.view('ws1').services.filter((s) => s.copyOf);
    expect(copies.map((s) => s.options)).toEqual([
      [{ key: '-Dmart.database.password', value: '${MART_DATABASE_PASSWORD}' }],
      [{ key: '-Dmart.database.password', value: '${MART_DATABASE_PASSWORD_2}' }],
    ]);
    expect(JSON.stringify(loadStack(dataDir, 'ws1'))).not.toContain('mart-one');
  });
});

describe('ServicesManager tasks', () => {
  it('adds a task in the same checkout and makes the service wait for it', () => {
    fs.writeFileSync(path.join(repo, 'gradlew'), '');
    fs.writeFileSync(path.join(repo, 'build.gradle'), "plugins { id 'maven-publish' }");
    const { mgr } = manager();
    mgr.addService('w1', { ...spec, projectId: 'p1' }, { ref: 'master', path: repo });

    const publish = mgr.taskPresets('w1', 'api').find((p) => p.id === 'gradle-publish-local');
    expect(publish).toBeDefined();
    const id = mgr.addTask('w1', 'api', { name: publish!.name, command: publish!.command, runBefore: true });

    const view = mgr.view('w1');
    const task = view.services.find((s) => s.id === id);
    expect(task).toMatchObject({ task: true, projectId: 'p1', command: publish!.command });
    expect(view.bindings.find((b) => b.serviceId === id)).toMatchObject({ ref: 'master', path: repo });
    expect(view.services.find((s) => s.id === 'api')?.deps).toEqual([id]);
  });

  it('leaves the service alone when the task is not to run before it', () => {
    const { mgr } = manager();
    mgr.addService('w1', spec, { ref: 'master', path: repo });
    mgr.addTask('w1', 'api', { name: 'image', command: ['docker', 'build', '.'], runBefore: false });
    expect(mgr.view('w1').services.find((s) => s.id === 'api')?.deps).toBeUndefined();
  });

  it('refuses a dependency that would make a loop, and one that does not exist', () => {
    const { mgr } = manager();
    mgr.addService('w1', { ...spec, id: 'lib', name: 'lib' });
    mgr.addService('w1', { ...spec, id: 'api', deps: ['lib'] });

    mgr.setDeps('w1', 'lib', ['api', 'ghost', 'lib']);
    expect(mgr.view('w1').services.find((s) => s.id === 'lib')?.deps).toBeUndefined();

    mgr.setDeps('w1', 'api', ['lib', 'lib']);
    expect(mgr.view('w1').services.find((s) => s.id === 'api')?.deps).toEqual(['lib']);
  });
});

describe('local config on a worktree swap', () => {
  it('brings the main checkout local config into the worktree a service is rebound to', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'billing/src/main/resources/config'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'application-local.properties\n');
    fs.writeFileSync(path.join(repo, 'billing/src/main/resources/config/application.properties'), 'a=1\n');
    fs.writeFileSync(path.join(repo, 'billing/src/main/resources/config/application-local.properties'), 'acme.url=http://localhost\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const worktree = path.join(repo, '..', `${path.basename(repo)}-wt`);
    git('worktree', 'add', '-q', '-b', 'feature/x', worktree);

    try {
      const { mgr } = manager();
      mgr.addService('ws1', spec, { ref: 'main', path: repo });
      await mgr.rebind('ws1', spec.id, { ref: 'feature/x', path: worktree });

      const linked = path.join(worktree, 'billing/src/main/resources/config/application-local.properties');
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(linked, 'utf8')).toContain('acme.url');
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
