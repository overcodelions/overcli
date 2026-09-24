import { describe, expect, it } from 'vitest';
import {
  applyMachineValues,
  expandIntellij,
  factorCommon,
  parseCompose,
  parseIntellijRunConfig,
  parseIntellijWorkspace,
  parseProcfile,
  parseTiltfile,
  withNodeVersion,
  parseVsCodeLaunch,
  parseVsCodeTasks,
  stripJsonc,
  suggestMachineValues,
  uniqueEnvName,
  type ImportedService,
} from './importers';

// The shape of a real `.idea/runConfigurations/*.xml`, trimmed.
function intellij(name: string, vm: string, extra = ''): string {
  return `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${name}" type="SpringBootApplicationConfigurationType" folderName="Core-Mono">
    <module name="AcmeProcessor_main" />
    <option name="VM_PARAMETERS" value="${vm}" />
    <option name="WORKING_DIRECTORY" value="file://$USER_HOME$/gitrepo/AcmeProcessor" />
    ${extra}
  </configuration>
</component>`;
}

describe('parseIntellijRunConfig', () => {
  it('reads the name, the VM options and the module', () => {
    const parsed = parseIntellijRunConfig(
      intellij('Acme Proc [Procs]', '-Xmx1024m -Dproc.type=PROC,PROC_HIGH'),
      '/Users/x',
    );
    expect(parsed?.name).toBe('Acme Proc [Procs]');
    expect(parsed?.options).toEqual([
      { key: '-Xmx1024m' },
      { key: '-Dproc.type', value: 'PROC,PROC_HIGH' },
    ]);
    expect(parsed?.moduleHint).toBe('AcmeProcessor');
  });

  it('turns the Spring profile field into the flag the process needs', () => {
    // IntelliJ keeps ACTIVE_PROFILES in its own field; a JVM only understands
    // the flag.
    const parsed = parseIntellijRunConfig(
      intellij('BillingRest', '-Xmx512m', '<option name="ACTIVE_PROFILES" value="local" />'),
    );
    expect(parsed?.options).toContainEqual({ key: '-Dspring.profiles.active', value: 'local' });
  });

  it('does not duplicate a profile the VM options already set', () => {
    const parsed = parseIntellijRunConfig(
      intellij('X', '-Dspring.profiles.active=local', '<option name="ACTIVE_PROFILES" value="local" />'),
    );
    expect(parsed?.options.filter((o) => o.key === '-Dspring.profiles.active')).toHaveLength(1);
  });

  it('decodes the entities IntelliJ escapes quoted paths with', () => {
    const parsed = parseIntellijRunConfig(intellij('X', '-Ddir=&quot;/tmp/a b&quot;'));
    expect(parsed?.options).toEqual([{ key: '-Ddir', value: '/tmp/a b' }]);
  });

  it('takes the module directory as the subpath', () => {
    const parsed = parseIntellijRunConfig(intellij('X', '-Xmx1g'), '/Users/x');
    expect(parsed?.subpath).toBe('AcmeProcessor');
  });

  it('reads the folder as a group, since that is what it is used for', () => {
    expect(parseIntellijRunConfig(intellij('X', ''))?.group).toBe('Core-Mono');
  });

  it('reads environment variables when the config has them', () => {
    const withEnv = intellij('X', '', '<envs><env name="AWS_REGION" value="us-east-1" /></envs>');
    expect(parseIntellijRunConfig(withEnv)?.env).toEqual({ AWS_REGION: 'us-east-1' });
  });

  it('ignores a file that is not a run configuration', () => {
    expect(parseIntellijRunConfig('<component/>')).toBeNull();
  });
});

describe('parseIntellijWorkspace', () => {
  it('reads the run configurations kept in workspace.xml, skipping templates and temporary ones', () => {
    const xml = `<project version="4">
  <component name="ChangeListManager"><configuration name="not-a-run-config" /></component>
  <component name="RunManager" selected="Spring Boot.AcmeRest">
    <configuration name="AcmeRest" type="SpringBootApplicationConfigurationType" folderName="Core-Mono">
      <module name="AcmeREST_main" />
      <option name="VM_PARAMETERS" value="-Xmx2g" />
    </configuration>
    <configuration name="Main" type="Application" temporary="true">
      <module name="AcmeREST_main" />
    </configuration>
    <configuration default="true" type="SpringBootApplicationConfigurationType">
      <option name="VM_PARAMETERS" value="" />
    </configuration>
  </component>
</project>`;
    const parsed = parseIntellijWorkspace(xml);
    expect(parsed.map((s) => s.name)).toEqual(['AcmeRest']);
    expect(parsed[0]).toMatchObject({ moduleHint: 'AcmeREST', group: 'Core-Mono' });
    expect(parsed[0].options).toEqual([{ key: '-Xmx2g' }]);
  });

  it('finds nothing when there is no RunManager', () => {
    expect(parseIntellijWorkspace('<project version="4"></project>')).toEqual([]);
  });
});

describe('expandIntellij', () => {
  it('expands the path variables rather than passing them through as nonsense', () => {
    expect(expandIntellij('file://$USER_HOME$/gitrepo', '/Users/x')).toBe('/Users/x/gitrepo');
    expect(expandIntellij('$PROJECT_DIR$/sub', '/Users/x')).toBe('./sub');
  });
});

describe('parseVsCodeLaunch', () => {
  it('reads a node launch with its runtime and args', () => {
    const services = parseVsCodeLaunch(
      JSON.stringify({
        configurations: [
          {
            name: 'Dev server',
            type: 'node',
            request: 'launch',
            runtimeExecutable: 'npm',
            runtimeArgs: ['run', 'dev'],
            env: { PORT: '3001' },
          },
        ],
      }),
    );
    expect(services[0].command).toEqual(['npm', 'run', 'dev']);
    expect(services[0].env).toEqual({ PORT: '3001' });
  });

  it('skips an attach configuration, which runs nothing', () => {
    // Attaching connects to something already running — the opposite of what
    // an import is for.
    const services = parseVsCodeLaunch(
      JSON.stringify({
        configurations: [{ name: 'Attach: billing-rest', type: 'java', request: 'attach', port: 8988 }],
      }),
    );
    expect(services).toEqual([]);
  });

  it('survives comments and trailing commas, which launch.json has by default', () => {
    const text = `{
      // VS Code writes this comment itself
      "configurations": [
        { "name": "api", "type": "python", "request": "launch", "module": "uvicorn", },
      ],
    }`;
    expect(parseVsCodeLaunch(text)[0].command).toEqual(['python', '-m', 'uvicorn']);
  });

  it('strips the workspace-folder prefix from a path', () => {
    const services = parseVsCodeLaunch(
      JSON.stringify({
        configurations: [
          { name: 'go', type: 'go', request: 'launch', program: '${workspaceFolder}/cmd/api' },
        ],
      }),
    );
    expect(services[0].command).toEqual(['go', 'run', 'cmd/api']);
  });

  it('keeps a java config for pairing even though it names no command', () => {
    const services = parseVsCodeLaunch(
      JSON.stringify({
        configurations: [
          {
            name: 'Api',
            type: 'java',
            request: 'launch',
            mainClass: 'com.x.Main',
            projectName: 'api',
            vmArgs: '-Xmx1g -Dspring.profiles.active=local',
          },
        ],
      }),
    );
    expect(services[0].command).toBeUndefined();
    expect(services[0].moduleHint).toBe('api');
    expect(services[0].options).toHaveLength(2);
  });
});

describe('stripJsonc', () => {
  it('leaves a // inside a string alone', () => {
    expect(stripJsonc('{"url":"http://x"}')).toBe('{"url":"http://x"}');
  });

  it('removes block comments', () => {
    expect(stripJsonc('{/* hi */"a":1}')).toBe('{"a":1}');
  });
});

describe('parseCompose', () => {
  const yaml = `
services:
  db:
    image: mysql:8
    ports: ["3306:3306"]
    environment:
      MYSQL_ROOT_PASSWORD: secret
  cache:
    image: redis
    ports:
      - 6379
`;

  it('reads each service with its published port', () => {
    const set = parseCompose(yaml, 'docker-compose.yml');
    expect(set?.services.map((s) => s.name)).toEqual(['db', 'cache']);
    expect(set?.services[0].port).toBe(3306);
    expect(set?.services[1].port).toBe(6379);
  });

  it('takes the host side of a mapping, not the container side', () => {
    const set = parseCompose('services:\n  web:\n    ports: ["8080:80"]\n', 'c.yml');
    expect(set?.services[0].port).toBe(8080);
  });

  it('reads both spellings of environment', () => {
    const set = parseCompose(yaml, 'docker-compose.yml');
    expect(set?.services[0].env).toEqual({ MYSQL_ROOT_PASSWORD: 'secret' });
    const listForm = parseCompose('services:\n  a:\n    environment:\n      - K=v\n', 'c.yml');
    expect(listForm?.services[0].env).toEqual({ K: 'v' });
  });

  it('brings each one up by name', () => {
    const set = parseCompose(yaml, 'docker-compose.yml');
    expect(set?.services[0].command).toEqual(['docker', 'compose', '-f', 'docker-compose.yml', 'up', 'db']);
  });

  it('returns nothing for a file with no services', () => {
    expect(parseCompose('version: "3"', 'c.yml')).toBeNull();
    expect(parseCompose(':::not yaml:::', 'c.yml')).toBeNull();
  });
});

describe('parseProcfile', () => {
  it('reads one service per line', () => {
    expect(parseProcfile('web: npm run start\nworker: node worker.js\n')).toEqual([
      { name: 'web', command: ['npm', 'run', 'start'], options: [], env: {}, source: 'procfile' },
      { name: 'worker', command: ['node', 'worker.js'], options: [], env: {}, source: 'procfile' },
    ]);
  });

  it('ignores comments and blanks', () => {
    expect(parseProcfile('# the web one\n\nweb: npm start')).toHaveLength(1);
  });
});

describe('parseTiltfile', () => {
  it('reads direct local_resource calls with their serve command and label', () => {
    const tiltfile = `
local_resource(
    'api',
    serve_cmd='npm run dev',
    labels=['1-rest'],
)
local_resource(
    'worker',
    serve_cmd='python worker.py',
    labels=['3-procs'],
)
`;
    const found = parseTiltfile(tiltfile);
    expect(found.map((s) => s.name)).toEqual(['api', 'worker']);
    expect(found[0].command).toEqual(['npm', 'run', 'dev']);
    // Tilt labels are commonly sort-prefixed; the prefix is ordering, not
    // meaning.
    expect(found[0].group).toBe('rest');
  });

  it('invents nothing from a helper it cannot see the definition of', () => {
    // A call to a function defined in another file is not evidence of a
    // service — better to find nothing than to guess at its arguments.
    expect(parseTiltfile("mono_app('acme-rest', 'AcmeREST', 'acme-rest.sh', 8083)")).toEqual([]);
  });

  // The shape of the real acme-local-dev Tiltfile, trimmed: services are
  // declared through helpers, and the helpers call local_resource.
  const helpers = `
LOCAL_DEV_DIR = SERVICES_DIR + '/acme-local-dev'

def mono_app(name, gradle_module, args_script, port, group='0-mono', auto_init=False, debug_port=0):
    args_path = LOCAL_DEV_DIR + '/mono-args/' + args_script
    links = []
    if port > 0:
        links = ['http://localhost:' + str(port)]
    local_resource(
        name,
        serve_cmd=['sh', '-c', cmd],
        labels=[group],
        links=links,
    )

def microservice(name, repo, gradle_module, port, group, auto_init=True, client_module=None):
    local_resource(
        name,
        serve_cmd=['sh', '-c', serve_cmd],
        labels=[group],
    )

def frontend(name, repo, node_version, start, link, subdir=''):
    local_resource(name, serve_cmd=['sh', '-c', start], links=[link])

# local_resource('commented-out', serve_cmd='nope')

mono_app('acme-rest',   'AcmeREST',      'acme-rest.sh',       8083, group='1-rest')
mono_app('acme-proc-dm', 'AcmeProcessor', 'acme-proc-dm.sh',   0, group='3-procs', debug_port=6004)
microservice('content-svc', 'acme-content-svc', 'content-service', 5024, '2-core', client_module='content-service-client')
frontend(
    'acme-web',
    'acme-web',
    'v22.16.0',
    'npm start',
    'http://localhost:3000',
)
local_resource(
    'api-tests',
    cmd=['sh', '-c', 'pytest -q'],
)
local_resource(
    'acme-directory',
    serve_cmd=['sh', '-c', NVM_INIT + 'npm run dev'],
    labels=['5-ui'],
)
`;

  const script = `#!/usr/bin/env bash
: "\${SQS_PREFIX:?SQS_PREFIX not set}"

echo "\\
-Xms512m \\
-Dspring.profiles.active=local \\
-Ddatabase.userid=\${DB_USER} \\
-Dproc.database.ip=10.0.0.4 \\
-Dlogging.level.com.acme=ERROR\\
"
`;

  const read = (relative: string) =>
    relative === 'mono-args/acme-proc-dm.sh' ? script : null;

  it('finds the services a Tiltfile declares through its own helpers', () => {
    // Thirty services behind four helpers, none of which the old parser saw.
    const found = parseTiltfile(helpers, read);
    expect(found.map((s) => s.name)).toEqual([
      'acme-rest',
      'acme-proc-dm',
      'content-svc',
      'acme-web',
      'api-tests',
      'acme-directory',
    ]);
  });

  it('binds positional and keyword arguments to the helper parameters', () => {
    const found = parseTiltfile(helpers, read);
    const content = found.find((s) => s.name === 'content-svc');
    expect(content).toMatchObject({ port: 5024, group: 'core', moduleHint: 'content-service' });
    const rest = found.find((s) => s.name === 'acme-rest');
    expect(rest).toMatchObject({ port: 8083, group: 'rest', moduleHint: 'AcmeREST' });
  });

  it('gives a processor no port rather than a zero', () => {
    const proc = parseTiltfile(helpers, read).find((s) => s.name === 'acme-proc-dm');
    expect(proc?.port).toBeUndefined();
  });

  it('imports explicit and conventional Tilt debug ports', () => {
    const found = parseTiltfile(helpers, read);
    expect(found.find((s) => s.name === 'acme-proc-dm')?.debugPort).toBe(6004);
    expect(found.find((s) => s.name === 'content-svc')?.debugPort).toBeUndefined();

    const conventional = parseTiltfile(`
def microservice(name, port):
    debug_port = port + 900
    local_resource(name, serve_cmd=['gradle', 'bootRun'])
microservice('api', 5016)
`);
    expect(conventional[0]?.debugPort).toBe(5916);
  });

  it('reads the JVM args script a helper points at', () => {
    // Where the fifty-seven options actually live — including the profile
    // flag that SPRING_PROFILES_ACTIVE could not deliver.
    const proc = parseTiltfile(helpers, read).find((s) => s.name === 'acme-proc-dm');
    expect(proc?.options).toContainEqual({ key: '-Dspring.profiles.active', value: 'local' });
    expect(proc?.options).toContainEqual({ key: '-Dproc.database.ip', value: '10.0.0.4' });
    // Left for the machine values to fill, not resolved or dropped.
    expect(proc?.options).toContainEqual({ key: '-Ddatabase.userid', value: '${DB_USER}' });
    expect(proc?.options).toHaveLength(5);
  });

  it('takes a port from a localhost link when the helper has no port parameter', () => {
    expect(parseTiltfile(helpers, read).find((s) => s.name === 'acme-web')?.port).toBe(3000);
  });

  it('skips commented-out resources and names inside helper bodies', () => {
    // The old parser listed "http://localhost:" as a service — it read the
    // link out of mono_app's own body.
    const names = parseTiltfile(helpers, read).map((s) => s.name);
    expect(names).not.toContain('commented-out');
    expect(names.some((n) => n.startsWith('http'))).toBe(false);
  });

  it('brings a one-off resource in as a task, with what waits on it', () => {
    const tiltfile = `
SERVICES_DIR = '..'

def microservice(name, repo, port, resource_deps=[]):
    local_resource(name, serve_cmd=['sh', '-c', 'gradle bootRun'], resource_deps=resource_deps)

local_resource(
    'common-publish',
    cmd='cd ../acme-common && ./gradlew publishToMavenLocal',
    dir=SERVICES_DIR + '/acme-common',
    labels=['0-build'],
)
local_resource('api', serve_cmd='npm run dev', resource_deps=['common-publish'])
microservice('content-svc', 'acme-content-svc', 5024, resource_deps=['common-publish', 'api'])
`;
    const found = parseTiltfile(tiltfile);
    expect(found.find((s) => s.name === 'common-publish')).toMatchObject({
      task: true,
      repoHint: 'acme-common',
      group: 'build',
      // Tilt runs a string command through the shell; split on spaces it
      // would run a program called `cd`.
      command: ['sh', '-c', 'cd ../acme-common && ./gradlew publishToMavenLocal'],
    });
    expect(found.find((s) => s.name === 'api')).toMatchObject({ deps: ['common-publish'] });
    expect(found.find((s) => s.name === 'api')?.task).toBeUndefined();
    // Handed through the helper's own parameter.
    expect(found.find((s) => s.name === 'content-svc')?.deps).toEqual(['common-publish', 'api']);
  });

  it('says which repo each resource runs in', () => {
    // The name is Tilt's; the repo is what decides the project. Neither
    // `admin-console` nor `legacy-portal` is the name of the folder it lives in.
    const tiltfile = `
SERVICES_DIR = os.path.abspath(os.getenv('SERVICES_DIR', '..'))
LEGACY_PORTAL_REPO = SERVICES_DIR + '/legacy-portal'

def frontend(name, repo, node_version, start, link, subdir=''):
    repo_path = SERVICES_DIR + '/' + repo
    local_resource(name, serve_cmd=['sh', '-c', start], serve_dir=repo_path, labels=['4-ui'], links=[link])

def apache_frontend(name, repo_path, url):
    local_resource(name, serve_cmd=['sh', '-c', 'tail ' + url], labels=['4-ui'])

frontend('admin-console', 'acme-admin-console', 'v12.22.5', 'ng serve', 'https://localhost:4200', subdir='admin-ui')
apache_frontend('legacy-portal', LEGACY_PORTAL_REPO, 'http://local.legacy-portal.com')
local_resource(
    'acme-directory',
    serve_cmd=['sh', '-c', NVM_INIT + 'npm run dev'],
    serve_dir=SERVICES_DIR + '/acme-directory',
)
`;
    const found = parseTiltfile(tiltfile);
    expect(found.find((s) => s.name === 'admin-console')).toMatchObject({
      repoHint: 'acme-admin-console',
      subpath: 'admin-ui',
      group: 'ui',
      nodeVersion: 'v12.22.5',
    });
    // The call and the helper both ride along, for Ask AI to read.
    const admin = found.find((s) => s.name === 'admin-console')?.excerpt ?? '';
    expect(admin).toContain("frontend('admin-console'");
    expect(admin).toContain('def frontend(');
    expect(found.find((s) => s.name === 'legacy-portal')?.repoHint).toBe('legacy-portal');
    expect(found.find((s) => s.name === 'acme-directory')?.repoHint).toBe('acme-directory');
  });

  it('runs a command under the Node version the file switches to', () => {
    expect(withNodeVersion(['npm', 'run', 'start'], 'v12.22.5')).toEqual([
      'sh',
      '-c',
      '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use v12.22.5 && exec npm run start',
    ]);
    // Arguments are quoted, not reinterpreted.
    expect(withNodeVersion(['node', "it's here"], '18')[2]).toContain(`exec node 'it'\\''s here'`);
    // Something that is not a version is not pasted into a shell line.
    expect(withNodeVersion(['npm', 'start'], 'v12; rm -rf ~')).toEqual(['npm', 'start']);
  });

  it('leaves the command unknown when the Tiltfile builds it by concatenation', () => {
    // Detection supplies it instead; guessing at half a shell string would
    // launch something nobody wrote.
    const dir = parseTiltfile(helpers, read).find((s) => s.name === 'acme-directory');
    expect(dir?.command).toBeUndefined();
    expect(dir?.group).toBe('ui');
  });

  // An Apache-served checkout: nothing in the repo to detect, so the helper's
  // own shell line is the only start command there is.
  const apache = `
SERVICES_DIR = os.path.abspath(os.getenv('SERVICES_DIR', '..'))
LEGACY_REPO = SERVICES_DIR + '/legacy-portal'
ERR_LOG = '/var/log/apache2/error_log'
NVM_INIT = 'source ~/.nvm/nvm.sh && '

def _flag(name):
    return '/tmp/tilt-worktree-' + name

def apache_frontend(name, repo_path, url, err_log):
    f = _flag(name)
    sync = 'SEL="$(cat ' + f + ' || echo ' + repo_path + ')"; '
    ready = 'until curl -sf ' + url + '; do sleep 2; done; '
    ready += ('echo "Serving ' + name +
              ' at ' + url + '"; ')
    serve = sync + ready + 'exec tail -F ' + err_log
    local_resource(name, serve_cmd=['sh', '-c', serve], labels=['4-ui'])
    serve = 'something after the resource'

def frontend(name, start, subdir=''):
    resolve = 'cd app; '
    if subdir != '':
        resolve = resolve + 'cd "' + subdir + '"; '
    local_resource(name, serve_cmd=['sh', '-c', resolve + start])

apache_frontend('legacy-portal', LEGACY_REPO, 'http://local.legacy-portal.com', ERR_LOG)
frontend('acme-web', 'npm start')
local_resource('acme-directory', serve_cmd=NVM_INIT + 'npm run dev')
`;

  it('reads a helper command built from parameters, locals, globals and one-line helpers', () => {
    const found = parseTiltfile(apache, undefined, { dir: '/work/acme-local-dev', env: {} });
    const portal = found.find((s) => s.name === 'legacy-portal');
    expect(portal?.command).toBeUndefined();
    expect(portal?.helperCommand).toEqual([
      'sh',
      '-c',
      'SEL="$(cat /tmp/tilt-worktree-legacy-portal || echo /work/legacy-portal)"; ' +
        'until curl -sf http://local.legacy-portal.com; do sleep 2; done; ' +
        'echo "Serving legacy-portal at http://local.legacy-portal.com"; ' +
        'exec tail -F /var/log/apache2/error_log',
    ]);
  });

  it('takes the environment over a getenv default', () => {
    const found = parseTiltfile(apache, undefined, { dir: '/work/acme-local-dev', env: { SERVICES_DIR: '/srv' } });
    expect(found.find((s) => s.name === 'legacy-portal')?.helperCommand?.[2]).toContain('echo /srv/legacy-portal');
  });

  it('leaves a path it cannot resolve unknown rather than half-built', () => {
    // No context: os.getenv has nothing to read, so the whole line is unknown.
    expect(parseTiltfile(apache).find((s) => s.name === 'legacy-portal')?.helperCommand).toBeUndefined();
  });

  it('does not guess at a local set inside an if', () => {
    expect(parseTiltfile(apache).find((s) => s.name === 'acme-web')?.helperCommand).toBeUndefined();
  });

  it('reads a direct resource command joined from a global', () => {
    expect(parseTiltfile(apache).find((s) => s.name === 'acme-directory')?.command).toEqual([
      'sh',
      '-c',
      'source ~/.nvm/nvm.sh && npm run dev',
    ]);
  });
});

// ── the reason importing beats copy-pasting ─────────────────────────────────

describe('factorCommon', () => {
  function svc(name: string, options: string[]): ImportedService {
    return {
      name,
      options: options.map((o) => {
        const eq = o.indexOf('=');
        return eq === -1 ? { key: o } : { key: o.slice(0, eq), value: o.slice(eq + 1) };
      }),
      env: {},
      source: 'intellij',
    };
  }

  const configs = [
    svc('procs', ['-Xmx1024m', '-Ddatabase.password=5qlpa55', '-Dproc.type=PROC,PROC_HIGH']),
    svc('dm', ['-Xmx1024m', '-Ddatabase.password=5qlpa55', '-Dproc.type=DM,DM_HIGH']),
    svc('infra', ['-Xmx1024m', '-Ddatabase.password=5qlpa55', '-Dproc.type=INFRA']),
  ];

  it('shares what every config agrees on', () => {
    const { shared } = factorCommon(configs);
    expect(shared.map((o) => o.key)).toEqual(['-Xmx1024m', '-Ddatabase.password']);
  });

  it('leaves each config only its difference', () => {
    // The whole point: three services, one flag each, one database password.
    const { perService } = factorCommon(configs);
    expect(perService.map((p) => p.own)).toEqual([
      [{ key: '-Dproc.type', value: 'PROC,PROC_HIGH' }],
      [{ key: '-Dproc.type', value: 'DM,DM_HIGH' }],
      [{ key: '-Dproc.type', value: 'INFRA' }],
    ]);
  });

  it('does not share a key everyone sets to a different value', () => {
    const { shared } = factorCommon(configs);
    expect(shared.some((o) => o.key === '-Dproc.type')).toBe(false);
  });

  it('shares nothing when there is only one config to import', () => {
    const single = factorCommon([configs[0]]);
    expect(single.shared).toEqual([]);
    expect(single.perService[0].own).toHaveLength(3);
  });
});

describe('suggestMachineValues', () => {
  it('lifts credentials out of the shared options', () => {
    // A password in an imported option list is a password in every future
    // export of it.
    const { shared } = factorCommon([
      {
        name: 'a',
        options: [
          { key: '-Ddatabase.password', value: '5qlpa55' },
          { key: '-Daws.secretKey', value: 'abc' },
          { key: '-Xmx1024m' },
        ],
        env: {},
        source: 'intellij',
      },
      {
        name: 'b',
        options: [
          { key: '-Ddatabase.password', value: '5qlpa55' },
          { key: '-Daws.secretKey', value: 'abc' },
          { key: '-Xmx1024m' },
        ],
        env: {},
        source: 'intellij',
      },
    ]);
    expect(suggestMachineValues(shared)).toEqual([
      { name: 'DATABASE_PASSWORD', value: '5qlpa55', key: '-Ddatabase.password' },
      { name: 'AWS_SECRETKEY', value: 'abc', key: '-Daws.secretKey' },
    ]);
  });

  it('leaves ordinary options where they are', () => {
    expect(suggestMachineValues([{ key: '-Xmx1024m' }, { key: '-Ddatabase.name', value: 'acme' }])).toEqual(
      [],
    );
  });

  it('leaves a value that is already a reference where it is', () => {
    // A script that passes `${DB_PASSWORD}` has already named the value; a
    // second name holding that text would never reach the real one.
    expect(
      suggestMachineValues([
        { key: '-Ddatabase.password', value: '${DB_PASSWORD}' },
        { key: '-Dredshift.database.password', value: '$REDSHIFT_PASSWORD' },
        { key: '-Dro.database.password', value: 'pa$$word' },
      ]),
    ).toEqual([{ name: 'RO_DATABASE_PASSWORD', value: 'pa$$word', key: '-Dro.database.password' }]);
  });

  it('gives one name to a credential written twice', () => {
    expect(
      suggestMachineValues([
        { key: '-Ddatabase.password', value: '5qlpa55' },
        { key: '-Ddatabase.password', value: '5qlpa55' },
      ]),
    ).toEqual([{ name: 'DATABASE_PASSWORD', value: '5qlpa55', key: '-Ddatabase.password' }]);
  });

  it('gives two names to one key holding two different credentials', () => {
    expect(
      suggestMachineValues([
        { key: '-Dmart.database.password', value: 'one' },
        { key: '-Dmart.database.password', value: 'two' },
      ]),
    ).toEqual([
      { name: 'MART_DATABASE_PASSWORD', value: 'one', key: '-Dmart.database.password' },
      { name: 'MART_DATABASE_PASSWORD_2', value: 'two', key: '-Dmart.database.password' },
    ]);
  });
});

describe('uniqueEnvName', () => {
  it('turns a flag into a usable name', () => {
    expect(uniqueEnvName('-Ddatabase.password', new Set())).toBe('DATABASE_PASSWORD');
  });

  it('does not collide', () => {
    expect(uniqueEnvName('-Ddb.password', new Set(['DB_PASSWORD']))).toBe('DB_PASSWORD_2');
  });
});

describe('applyMachineValues', () => {
  it('rewrites the lifted options to refer to the value', () => {
    expect(
      applyMachineValues(
        [{ key: '-Ddatabase.password', value: '5qlpa55' }, { key: '-Xmx1g' }],
        [{ name: 'DATABASE_PASSWORD', key: '-Ddatabase.password', value: '5qlpa55' }],
      ),
    ).toEqual([{ key: '-Ddatabase.password', value: '${DATABASE_PASSWORD}' }, { key: '-Xmx1g' }]);
  });

  it('leaves a key alone when it holds a value that was not lifted', () => {
    // The same flag, a different secret: it has a name of its own, and must
    // not be rewritten to point at somebody else's.
    expect(
      applyMachineValues(
        [{ key: '-Ddatabase.password', value: 'another' }],
        [{ name: 'DATABASE_PASSWORD', key: '-Ddatabase.password', value: '5qlpa55' }],
      ),
    ).toEqual([{ key: '-Ddatabase.password', value: 'another' }]);
  });
});

describe('tasks from IntelliJ and VS Code', () => {
  const gradleConfig = (tasks: string[], script = '') => `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="publish common" type="GradleRunConfiguration" factoryName="Gradle" folderName="Build">
    <ExternalSystemSettings>
      <option name="executionName" />
      <option name="externalProjectPath" value="$PROJECT_DIR$" />
      <option name="scriptParameters" value="${script}" />
      <option name="taskNames">
        <list>
${tasks.map((t) => `          <option value="${t}" />`).join('\n')}
        </list>
      </option>
    </ExternalSystemSettings>
  </configuration>
</component>`;

  it('brings a Gradle configuration that publishes in as a task with its command', () => {
    expect(parseIntellijRunConfig(gradleConfig(['publishToMavenLocal'], '-x test'))).toMatchObject({
      name: 'publish common',
      task: true,
      group: 'Build',
      command: ['./gradlew', 'publishToMavenLocal', '-x', 'test', '-Dorg.gradle.daemon=false'],
      options: [],
    });
  });

  it('leaves a Gradle configuration that boots the app as a service', () => {
    expect(parseIntellijRunConfig(gradleConfig([':billing-rest:bootRun']))?.task).toBeUndefined();
  });

  it('brings a Maven install in as a task', () => {
    const xml = `<configuration name="install core" type="MavenRunConfiguration" factoryName="Maven">
  <MavenSettings>
    <option name="myRunnerParameters">
      <MavenRunnerParameters>
        <option name="goals">
          <list>
            <option value="clean" />
            <option value="install" />
          </list>
        </option>
      </MavenRunnerParameters>
    </option>
  </MavenSettings>
</configuration>`;
    expect(parseIntellijRunConfig(xml)).toMatchObject({ task: true, command: ['mvn', 'clean', 'install'] });
  });

  it('reads VS Code tasks, skipping watchers and provider tasks', () => {
    const found = parseVsCodeTasks(`{
  // comments are normal here
  "version": "2.0.0",
  "tasks": [
    { "label": "publish lib", "type": "shell", "command": "cd lib && ./gradlew publishToMavenLocal" },
    { "label": "image", "type": "process", "command": "docker", "args": ["build", "-t", "api", "."],
      "dependsOn": "publish lib", "options": { "cwd": "\${workspaceFolder}/api" } },
    { "label": "watch", "type": "shell", "command": "npm run watch", "isBackground": true },
    { "label": "npm build", "type": "npm", "script": "build" },
  ]
}`);
    expect(found.map((t) => t.name)).toEqual(['publish lib', 'image']);
    expect(found[0]).toMatchObject({
      task: true,
      command: ['sh', '-c', 'cd lib && ./gradlew publishToMavenLocal'],
    });
    expect(found[1]).toMatchObject({
      command: ['docker', 'build', '-t', 'api', '.'],
      deps: ['publish lib'],
      subpath: 'api',
    });
  });
});
