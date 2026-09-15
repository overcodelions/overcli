import { describe, expect, it } from 'vitest';
import {
  detectService,
  detectServices,
  parseGradleIncludes,
  parseMavenModules,
  type RepoReader,
} from './detect';

/// A checkout described by its files.
function repo(files: Record<string, string>): RepoReader {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => files[p] ?? null,
    // Directories are implied by the paths under them.
    list: (dir) => {
      const prefix = dir ? `${dir}/` : '';
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
        .map((p) => p.slice(prefix.length).split('/')[0]);
      return [...new Set(names)];
    },
  };
}

describe('detectService — spring boot', () => {
  const pom = '<project><artifactId>spring-boot-starter-web</artifactId></project>';

  it('reads the port out of application.yml and says where it found it', () => {
    // The evidence is the point: an inference you can check in two seconds is
    // one you will accept on day one.
    const proposal = detectService(
      repo({
        'pom.xml': pom,
        'mvnw': '',
        'src/main/resources/application.yml': 'server:\n  port: 8084\n',
      }),
      'billing-rest',
    );
    expect(proposal?.spec.port).toBe(8084);
    expect(proposal?.spec.command).toEqual(['./mvnw', 'spring-boot:run']);
    const port = proposal?.evidence.find((e) => e.field === 'port');
    expect(port?.source).toBe('src/main/resources/application.yml:2');
    expect(proposal?.confidence).toBe('high');
  });

  it('reads a flat properties port too', () => {
    const proposal = detectService(
      repo({ 'pom.xml': pom, 'src/main/resources/application.properties': 'server.port=9001\n' }),
      'svc',
    );
    expect(proposal?.spec.port).toBe(9001);
  });

  it('falls back to 8080 and drops its confidence when no port is set', () => {
    const proposal = detectService(repo({ 'pom.xml': pom }), 'svc');
    expect(proposal?.spec.port).toBe(8080);
    expect(proposal?.confidence).toBe('medium');
  });

  it('probes the actuator when it is on the classpath, the port otherwise', () => {
    const withActuator = detectService(
      repo({ 'pom.xml': `${pom}<dep>spring-boot-starter-actuator</dep>` }),
      'svc',
    );
    expect(withActuator?.spec.ready).toEqual({ kind: 'http', path: '/actuator/health', port: 8080 });
    expect(detectService(repo({ 'pom.xml': pom }), 'svc')?.spec.ready).toEqual({
      kind: 'tcp',
      port: 8080,
    });
  });

  it('keeps local config out of the checkout by injecting it', () => {
    const proposal = detectService(repo({ 'pom.xml': pom }), 'svc');
    expect(proposal?.spec.config.inject?.SPRING_CONFIG_ADDITIONAL_LOCATION).toBe(
      '${SERVICE_CONFIG_DIR}/',
    );
    expect(proposal?.spec.config.link).toBeUndefined();
  });

  it('marks a devtools service as self-reloading so we leave it alone', () => {
    const proposal = detectService(
      repo({ 'pom.xml': `${pom}<dep>spring-boot-devtools</dep>` }),
      'svc',
    );
    expect(proposal?.spec.selfReloads).toBe(true);
    expect(proposal?.spec.watch).toBeUndefined();
  });

  it('uses gradle when that is what the repo has', () => {
    const proposal = detectService(
      repo({ 'build.gradle': "id 'org.springframework.boot'", 'gradlew': '' }),
      'svc',
    );
    expect(proposal?.spec.runner).toBe('gradle');
    // The daemon flag rides along: without it the build reuses a daemon
    // started with an earlier environment, and the variables set for this
    // launch never reach the forked JVM.
    expect(proposal?.spec.command).toEqual(['./gradlew', 'bootRun', '-Dorg.gradle.daemon=false']);
  });

  it('ignores a java build with no spring on it', () => {
    expect(detectService(repo({ 'pom.xml': '<project/>' }), 'svc')).toBeNull();
  });
});

describe('detectService — node', () => {
  it('recognises angular and marks it self-reloading', () => {
    // The one that saves the most pain: overcli must not restart ng serve on
    // a file change, because ng serve already did something better.
    const proposal = detectService(
      repo({ 'package.json': '{"scripts":{"start":"ng serve"}}', 'angular.json': '{}' }),
      'admin-console',
    );
    expect(proposal?.spec.runner).toBe('ng-serve');
    expect(proposal?.spec.port).toBe(4200);
    expect(proposal?.spec.selfReloads).toBe(true);
  });

  it('prefers the dev script when there is one', () => {
    const proposal = detectService(
      repo({ 'package.json': '{"scripts":{"dev":"vite","start":"node ."}}', 'vite.config.ts': '' }),
      'web',
    );
    expect(proposal?.spec.command).toEqual(['npm', 'run', 'dev']);
    expect(proposal?.spec.port).toBe(5173);
  });

  it('reads the port out of the vite config instead of assuming the default', () => {
    // overgit sits on 5273 precisely so it does not fight overcli for 5173.
    // Proposing 5173 made the port check blame overcli's own dev server.
    const config = [
      "import { defineConfig } from 'vite';",
      'export default defineConfig({',
      '  preview: { port: 4173 },',
      '  server: {',
      '    // Off 5173 (port: 5173 is overcli)',
      '    port: 5273,',
      '    strictPort: true,',
      '  },',
      '});',
    ].join('\n');
    const proposal = detectService(
      repo({ 'package.json': '{"scripts":{"dev":"concurrently vite tsc"}}', 'vite.config.ts': config }),
      'overgit',
    );
    expect(proposal?.spec.port).toBe(5273);
    expect(proposal?.evidence.find((e) => e.field === 'port')?.source).toBe('vite.config.ts:6');
  });

  it('prefers a port flag in the script over the config', () => {
    const proposal = detectService(
      repo({
        'package.json': '{"scripts":{"dev":"vite --port 5400"}}',
        'vite.config.mts': 'export default { server: { port: 5273 } }',
      }),
      'web',
    );
    expect(proposal?.spec.port).toBe(5400);
    expect(proposal?.spec.runner).toBe('vite');
  });

  it('ignores a package with no way to run it', () => {
    expect(detectService(repo({ 'package.json': '{"name":"lib"}' }), 'lib')).toBeNull();
  });

  it('does not crash on malformed json', () => {
    expect(detectService(repo({ 'package.json': '{oops' }), 'lib')).toBeNull();
  });
});

describe('detectService — node package managers', () => {
  it('runs through pnpm when its lockfile is there', () => {
    const proposal = detectService(
      repo({ 'package.json': '{"scripts":{"dev":"vite"}}', 'vite.config.ts': '', 'pnpm-lock.yaml': '' }),
      'web',
    );
    expect(proposal?.spec.command).toEqual(['pnpm', 'run', 'dev']);
    expect(proposal?.spec.runner).toBe('vite');
    expect(proposal?.evidence.some((e) => e.source === 'pnpm-lock.yaml')).toBe(true);
  });

  it('keeps angular recognised under yarn', () => {
    const proposal = detectService(
      repo({ 'package.json': '{"scripts":{"start":"ng serve"}}', 'angular.json': '{}', 'yarn.lock': '' }),
      'admin',
    );
    expect(proposal?.spec.command).toEqual(['yarn', 'start']);
    expect(proposal?.spec.runner).toBe('ng-serve');
  });

  it('recognises both bun lockfile formats', () => {
    for (const lock of ['bun.lockb', 'bun.lock']) {
      const proposal = detectService(repo({ 'package.json': '{"scripts":{"dev":"bun --hot ."}}', [lock]: '' }), 'api');
      expect(proposal?.spec.command).toEqual(['bun', 'run', 'dev']);
    }
  });

  it('finds a workspace lockfile at the root for a nested package', () => {
    // A pnpm workspace keeps one lockfile at the top, none beside each package.
    const found = detectServices(
      repo({
        'settings.gradle': "include 'billing-angular'",
        'billing-angular/build.gradle': "apply plugin: 'base'",
        'billing-angular/src/package.json': '{"scripts":{"start":"ng serve"}}',
        'pnpm-lock.yaml': '',
      }),
      'gitrepo',
    );
    expect(found[0].spec.command).toEqual(['pnpm', 'run', 'start']);
  });

  it('falls back to the packageManager field when no lockfile is committed', () => {
    const proposal = detectService(
      repo({ 'package.json': '{"packageManager":"yarn@4.1.0","scripts":{"dev":"next dev"}}' }),
      'site',
    );
    expect(proposal?.spec.command).toEqual(['yarn', 'dev']);
  });

  it('uses npm when nothing says otherwise', () => {
    expect(detectService(repo({ 'package.json': '{"scripts":{"start":"node ."}}' }), 'x')?.spec.command).toEqual([
      'npm',
      'run',
      'start',
    ]);
  });
});

describe('detectService — deno', () => {
  it('runs the dev task out of a deno.jsonc with comments in it', () => {
    const config = [
      '{',
      '  // local only',
      '  "imports": { "std/": "https://deno.land/std@0.224.0/" },',
      '  "tasks": { "start": "deno run -A main.ts", "dev": "deno run -A --watch main.ts --port 8123", },',
      '}',
    ].join('\n');
    const proposal = detectService(repo({ 'deno.jsonc': config, 'package.json': '{"scripts":{"dev":"vite"}}' }), 'edge');
    expect(proposal?.spec.command).toEqual(['deno', 'task', 'dev']);
    expect(proposal?.spec.port).toBe(8123);
    expect(proposal?.spec.selfReloads).toBe(true);
  });

  it('falls back to start, in the object form, and restarts it itself', () => {
    const proposal = detectService(
      repo({ 'deno.json': '{"tasks":{"start":{"command":"deno run -A main.ts","description":"serve"}}}' }),
      'edge',
    );
    expect(proposal?.spec.command).toEqual(['deno', 'task', 'start']);
    expect(proposal?.spec.port).toBe(8000);
    expect(proposal?.spec.selfReloads).toBe(false);
    expect(proposal?.spec.watch).toBeDefined();
  });

  it('ignores a deno.json with no task to run', () => {
    expect(detectService(repo({ 'deno.json': '{"tasks":{"fmt":"deno fmt"}}' }), 'lib')).toBeNull();
  });
});

describe('detectServices — rust', () => {
  it('runs a single-binary crate with cargo run', () => {
    const found = detectServices(
      repo({ 'Cargo.toml': '[package]\nname = "api"\n\n[dependencies]\naxum = "0.7"\n', 'src/main.rs': '' }),
      'api-repo',
    );
    expect(found).toHaveLength(1);
    expect(found[0].spec.command).toEqual(['cargo', 'run']);
    expect(found[0].spec.name).toBe('api-repo');
    expect(found[0].confidence).toBe('medium');
    // axum binds whatever the code says; no port is better than a wrong one.
    expect(found[0].spec.port).toBeUndefined();
  });

  it('proposes one service per binary when a package has several', () => {
    const manifest = '[package]\nname = "tools"\n\n[[bin]]\nname = "server"\npath = "src/main.rs"\n\n[[bin]]\nname = "worker"\n';
    const found = detectServices(repo({ 'Cargo.toml': manifest, 'src/main.rs': '' }), 'tools');
    expect(found.map((f) => f.spec.command)).toEqual([
      ['cargo', 'run', '--bin', 'server'],
      ['cargo', 'run', '--bin', 'worker'],
    ]);
    expect(found[0].confidence).toBe('low');
  });

  it('runs each binary member of a workspace from the root', () => {
    const found = detectServices(
      repo({
        'Cargo.toml': '[workspace]\nmembers = [\n  "crates/*",\n  "tools/gen",\n]\n',
        'crates/api/Cargo.toml': '[package]\nname = "api"\n[dependencies]\nrocket = "0.5"\n',
        'crates/api/src/main.rs': '',
        // A library member: nothing to run.
        'crates/core/Cargo.toml': '[package]\nname = "core"\n',
        'crates/core/src/lib.rs': '',
        'tools/gen/Cargo.toml': '[package]\nname = "gen"\n',
        'tools/gen/src/bin/codegen.rs': '',
      }),
      'mono',
    );
    expect(found.map((f) => f.spec.name)).toEqual(['api', 'codegen']);
    expect(found[0].spec.command).toEqual(['cargo', 'run', '-p', 'api']);
    expect(found[0].spec.port).toBe(8000);
    expect(found[0].spec.subpath).toBeUndefined();
    expect(found[1].spec.command).toEqual(['cargo', 'run', '-p', 'gen']);
  });

  it('proposes nothing for a library crate', () => {
    expect(detectServices(repo({ 'Cargo.toml': '[package]\nname = "lib"\n', 'src/lib.rs': '' }), 'lib')).toEqual([]);
  });
});

describe('detectService — ruby', () => {
  it('recognises rails, reads the puma port, and beats its asset package.json', () => {
    const proposal = detectService(
      repo({
        'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
        'bin/rails': '',
        'config/puma.rb': 'threads 5, 5\nport ENV.fetch("PORT") { 3100 }\n',
        'package.json': '{"scripts":{"dev":"vite"}}',
      }),
      'shop',
    );
    expect(proposal?.spec.command).toEqual(['bin/rails', 'server']);
    expect(proposal?.spec.port).toBe(3100);
    expect(proposal?.evidence.find((e) => e.field === 'port')?.source).toBe('config/puma.rb:2');
    expect(proposal?.confidence).toBe('high');
    // Code reloads in place; only what Rails cannot reload restarts it.
    expect(proposal?.spec.selfReloads).toBe(false);
    expect(proposal?.spec.watch).toContain('config/**');
  });

  it('runs a plain rack app through bundler', () => {
    const proposal = detectService(repo({ 'Gemfile': 'gem "sinatra"', 'config.ru': 'run App' }), 'hooks');
    expect(proposal?.spec.command).toEqual(['bundle', 'exec', 'rackup']);
    expect(proposal?.spec.port).toBe(9292);
  });

  it('ignores a Gemfile with nothing to serve', () => {
    expect(detectService(repo({ 'Gemfile': 'gem "rake"' }), 'gem')).toBeNull();
  });
});

describe('detectService — elixir', () => {
  it('recognises phoenix and reads the endpoint port', () => {
    const proposal = detectService(
      repo({
        'mix.exs': 'defp deps do\n  [\n    {:phoenix, "~> 1.7.0"},\n  ]\nend',
        'config/dev.exs': 'config :app, AppWeb.Endpoint,\n  http: [ip: {127, 0, 0, 1}, port: 4001],\n  code_reloader: true',
      }),
      'app',
    );
    expect(proposal?.spec.command).toEqual(['mix', 'phx.server']);
    expect(proposal?.spec.port).toBe(4001);
    expect(proposal?.evidence.find((e) => e.field === 'port')?.source).toBe('config/dev.exs:2');
    expect(proposal?.spec.selfReloads).toBe(true);
    expect(proposal?.confidence).toBe('high');
  });

  it('defaults phoenix to 4000 when the dev config reads it from env', () => {
    const proposal = detectService(
      repo({
        'mix.exs': '{:phoenix, "~> 1.7"}',
        'config/dev.exs': 'http: [port: String.to_integer(System.get_env("PORT") || "4050")]',
      }),
      'app',
    );
    expect(proposal?.spec.port).toBe(4050);
  });

  it('offers a plain mix project at low confidence and no port', () => {
    const proposal = detectService(repo({ 'mix.exs': 'defp deps, do: [{:jason, "~> 1.4"}]' }), 'worker');
    expect(proposal?.spec.command).toEqual(['mix', 'run', '--no-halt']);
    expect(proposal?.spec.port).toBeUndefined();
    expect(proposal?.confidence).toBe('low');
  });
});

describe('detectServices — .net', () => {
  it('runs a web project and takes its port from the launch settings', () => {
    const found = detectServices(
      repo({
        'Shop.sln': '',
        'src/Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
        'src/Shop.Api/Properties/launchSettings.json':
          '{"profiles":{"api":{"applicationUrl":"https://localhost:7043;http://localhost:5043"}}}',
        'src/Shop.Core/Shop.Core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
        'tests/Shop.Tests/Shop.Tests.csproj':
          '<Project Sdk="Microsoft.NET.Sdk"><OutputType>Exe</OutputType><PackageReference Include="Microsoft.NET.Test.Sdk" /></Project>',
      }),
      'shop',
    );
    expect(found).toHaveLength(1);
    expect(found[0].spec.command).toEqual(['dotnet', 'run', '--project', 'src/Shop.Api/Shop.Api.csproj']);
    expect(found[0].spec.port).toBe(5043);
    expect(found[0].confidence).toBe('high');
  });

  it('does not offer a console app beside a web one', () => {
    const found = detectServices(
      repo({
        'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
        'Tool/Tool.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
      }),
      'repo',
    );
    expect(found.map((f) => f.spec.name)).toEqual(['repo']);
    expect(found[0].spec.port).toBe(5000);
    expect(found[0].confidence).toBe('medium');
  });

  it('offers a lone console app at low confidence', () => {
    const found = detectServices(
      repo({ 'Tool.csproj': '<Project Sdk="Microsoft.NET.Sdk"><OutputType>Exe</OutputType></Project>' }),
      'tool',
    );
    expect(found[0].spec.command).toEqual(['dotnet', 'run', '--project', 'Tool.csproj']);
    expect(found[0].spec.port).toBeUndefined();
    expect(found[0].confidence).toBe('low');
  });

  it('proposes nothing for a class library', () => {
    expect(detectServices(repo({ 'Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk" />' }), 'lib')).toEqual([]);
  });
});

describe('detectService — php', () => {
  it('recognises laravel ahead of its vite package.json', () => {
    const proposal = detectService(
      repo({
        'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
        'artisan': '',
        'package.json': '{"scripts":{"dev":"vite"}}',
      }),
      'portal',
    );
    expect(proposal?.spec.command).toEqual(['php', 'artisan', 'serve']);
    expect(proposal?.spec.port).toBe(8000);
    expect(proposal?.confidence).toBe('high');
  });

  it('offers the built-in server for symfony at low confidence', () => {
    const proposal = detectService(
      repo({ 'composer.json': '{"require":{"symfony/framework-bundle":"7.0.*"}}' }),
      'shop',
    );
    expect(proposal?.spec.command).toEqual(['php', '-S', 'localhost:8000', '-t', 'public']);
    expect(proposal?.confidence).toBe('low');
  });

  it('ignores a composer package that is neither', () => {
    expect(detectService(repo({ 'composer.json': '{"require":{"guzzlehttp/guzzle":"^7"}}' }), 'lib')).toBeNull();
  });
});

describe('detectService — python, go, compose', () => {
  it('recognises django', () => {
    const proposal = detectService(repo({ 'manage.py': '' }), 'admin');
    expect(proposal?.spec.command).toEqual(['python', 'manage.py', 'runserver']);
    expect(proposal?.spec.port).toBe(8000);
  });

  it('flags a guessed uvicorn module path as low confidence', () => {
    // We know it is FastAPI; we are guessing `app.main:app`. Say so rather
    // than presenting a guess as a finding.
    const proposal = detectService(repo({ 'pyproject.toml': 'fastapi = "^0.110"' }), 'api');
    expect(proposal?.confidence).toBe('low');
    expect(proposal?.spec.command[0]).toBe('uvicorn');
    expect(proposal?.spec.selfReloads).toBe(true);
    expect(proposal?.spec.watch).toBeUndefined();
  });

  it('restarts plain Flask on Python changes because debug reload is not guaranteed', () => {
    const proposal = detectService(repo({ 'requirements.txt': 'Flask==3.1.0' }), 'api');
    expect(proposal?.spec.command).toEqual(['flask', 'run']);
    expect(proposal?.spec.selfReloads).toBe(false);
    expect(proposal?.spec.watch).toEqual(['**/*.py']);
  });

  it('recognises go without inventing a port', () => {
    const proposal = detectService(repo({ 'go.mod': 'module x', 'cmd': '' }), 'edge');
    expect(proposal?.spec.port).toBeUndefined();
    expect(proposal?.spec.ready).toEqual({ kind: 'none' });
  });

  it('brings a compose file up as one unit', () => {
    const proposal = detectService(repo({ 'docker-compose.yml': 'services: {}' }), 'infra');
    expect(proposal?.spec.runner).toBe('docker-compose');
    expect(proposal?.spec.command).toEqual(['docker', 'compose', '-f', 'docker-compose.yml', 'up']);
  });

  it('returns nothing for a repo it does not recognise', () => {
    // Which is fine — you type the command once and everything downstream
    // behaves identically.
    expect(detectService(repo({ 'README.md': '# hi' }), 'docs')).toBeNull();
  });
});

// ── multi-module builds ─────────────────────────────────────────────────────
//
// The shape that matters most in practice: one checkout, a dozen modules, a
// handful of which boot. Treating the root as one service finds nothing you
// can actually run.

describe('parseGradleIncludes', () => {
  it('reads the groovy one-line include list', () => {
    expect(
      parseGradleIncludes("include 'acme-core', 'billing-rest', 'AcmeTest:AcmeManagersTest'"),
    ).toEqual(['acme-core', 'billing-rest', 'AcmeTest:AcmeManagersTest']);
  });

  it('reads the kotlin call form and strips the leading colon', () => {
    expect(parseGradleIncludes('include(":api", ":web")')).toEqual(['api', 'web']);
  });

  it('collects several include statements', () => {
    expect(parseGradleIncludes("include 'a'\ninclude 'b'")).toEqual(['a', 'b']);
  });

  it('ignores quoted strings outside an include', () => {
    // Settings files carry plugin blocks and credentials logic; none of that
    // is a project.
    const settings = [
      'pluginManagement {',
      '  repositories { maven { url "$ACME_MAVEN" } }',
      '}',
      "include 'billing-rest'",
    ].join('\n');
    expect(parseGradleIncludes(settings)).toEqual(['billing-rest']);
  });
});

describe('parseMavenModules', () => {
  it('reads an aggregator pom', () => {
    expect(
      parseMavenModules('<project><modules><module>api</module><module>web</module></modules></project>'),
    ).toEqual(['api', 'web']);
  });

  it('returns nothing for a single-module pom', () => {
    expect(parseMavenModules('<project/>')).toEqual([]);
  });
});

describe('detectServices — a multi-module gradle build', () => {
  const bootModule = (extra = '') => `apply plugin: 'org.springframework.boot'\nbootRun {\n}\n${extra}`;
  const files = {
    'settings.gradle': "include 'acme-core', 'billing-rest', 'AcmeProcessor'",
    'build.gradle': "classpath('org.springframework.boot:spring-boot-gradle-plugin')",
    'gradlew': '',
    // A library: spring is on its classpath, but there is no way to run it.
    'acme-core/build.gradle': "apply plugin: 'java'\ncompile 'org.springframework.boot:spring-boot-starter'",
    'billing-rest/build.gradle': bootModule(
      "compile 'org.springframework.boot:spring-boot-starter-web'\ncompile 'org.springframework.boot:spring-boot-starter-actuator'",
    ),
    // Config in the older `config/` location rather than Spring's default.
    'billing-rest/src/main/resources/config/application.properties': 'server.port=8088\n',
    // A worker: boots, serves nothing.
    'AcmeProcessor/build.gradle': bootModule(),
  };

  it('proposes one service per bootable module, and none for the libraries', () => {
    const found = detectServices(repo(files), 'gitrepo');
    expect(found.map((f) => f.spec.name)).toEqual(['billing-rest', 'AcmeProcessor']);
  });

  it('runs each module from the root with a qualified task', () => {
    // Running from inside the module cannot resolve its sibling projects —
    // this is the difference between starting and not.
    const found = detectServices(repo(files), 'gitrepo');
    expect(found[0].spec.command).toEqual([
      './gradlew',
      ':billing-rest:bootRun',
      '-Dorg.gradle.daemon=false',
    ]);
    expect(found[0].spec.subpath).toBeUndefined();
  });

  it('finds a port kept in the config/ subdirectory', () => {
    const found = detectServices(repo(files), 'gitrepo');
    expect(found[0].spec.port).toBe(8088);
    expect(found[0].evidence.find((e) => e.field === 'port')?.source).toBe(
      'billing-rest/src/main/resources/config/application.properties:1',
    );
  });

  it('invents no port for a module that serves nothing', () => {
    // Defaulting a worker to 8080 would manufacture a clash with whichever
    // module in the same build really is the web app.
    const worker = detectServices(repo(files), 'gitrepo').find((f) => f.spec.name === 'AcmeProcessor');
    expect(worker?.spec.port).toBeUndefined();
    expect(worker?.spec.ready).toEqual({ kind: 'none' });
  });

  it('maps a nested gradle path to its directory', () => {
    const nested = {
      'settings.gradle': "include 'AcmeTest:AcmeManagersTest'",
      'gradlew': '',
      'AcmeTest/AcmeManagersTest/build.gradle': "apply plugin: 'org.springframework.boot'\nbootRun {}",
    };
    const found = detectServices(repo(nested), 'gitrepo');
    expect(found[0].spec.command).toEqual([
      './gradlew',
      ':AcmeTest:AcmeManagersTest:bootRun',
      '-Dorg.gradle.daemon=false',
    ]);
    expect(found[0].spec.name).toBe('AcmeManagersTest');
  });

  it('falls back to the root when no module boots', () => {
    const libsOnly = {
      'settings.gradle': "include 'acme-core'",
      'acme-core/build.gradle': "apply plugin: 'java'",
      'package.json': '{"scripts":{"dev":"vite"}}',
    };
    expect(detectServices(repo(libsOnly), 'tools')[0]?.spec.runner).toBe('npm');
  });
});

describe('detectServices — a maven aggregator', () => {
  it('proposes each module that has the boot plugin', () => {
    const found = detectServices(
      repo({
        'pom.xml': '<project><modules><module>api</module><module>common</module></modules></project>',
        'mvnw': '',
        'api/pom.xml': '<project><artifactId>spring-boot-maven-plugin</artifactId></project>',
        'common/pom.xml': '<project><artifactId>commons-lang3</artifactId></project>',
      }),
      'shop',
    );
    expect(found).toHaveLength(1);
    expect(found[0].spec.command).toEqual(['./mvnw', '-pl', 'api', 'spring-boot:run']);
    expect(found[0].spec.subpath).toBe('api');
  });
});

describe('detectServices — a web app nested inside a module', () => {
  it('looks one level down for a package.json', () => {
    const found = detectServices(
      repo({
        'settings.gradle': "include 'billing-angular'",
        'billing-angular/build.gradle': "apply plugin: 'base'",
        'billing-angular/src/package.json': '{"scripts":{"start":"ng serve"}}',
        'billing-angular/src/angular.json': '{}',
      }),
      'gitrepo',
    );
    expect(found[0].spec.subpath).toBe('billing-angular/src');
    expect(found[0].spec.runner).toBe('ng-serve');
  });

  it('skips a module whose package.json has no way to run it', () => {
    // billing-angular is built by gradle; its package.json carries no scripts.
    const found = detectServices(
      repo({
        'settings.gradle': "include 'billing-angular'",
        'billing-angular/build.gradle': "apply plugin: 'base'",
        'billing-angular/src/package.json': '{"dependencies":{}}',
      }),
      'gitrepo',
    );
    expect(found).toEqual([]);
  });
});

describe('detectService — the local profile', () => {
  const gradle = "plugins { id 'org.springframework.boot' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }";

  it('takes the port from the local profile over the base config', () => {
    // content-service: 5000 in application.yaml, moved to 5024 by a gitignored
    // config/application-local.yaml. Reading the base file first launched it
    // expecting a port it never opens.
    const proposal = detectService(
      repo({
        'build.gradle': gradle,
        'src/main/resources/application.yaml': 'spring:\n  application:\n    name: content\nserver:\n  port: 5000\n',
        'src/main/resources/config/application-local.yaml': 'server:\n  port: 5024\n',
      }),
      'content-service',
    );
    expect(proposal?.spec.port).toBe(5024);
    expect(proposal?.spec.config.inject?.SPRING_PROFILES_ACTIVE).toBe('local');
    const port = proposal?.evidence.find((e) => e.field === 'port');
    expect(port?.why).toContain('local profile');
    expect(port?.source).toContain('application-local.yaml');
  });

  it('does not activate a profile the module does not have', () => {
    const proposal = detectService(
      repo({ 'build.gradle': gradle, 'src/main/resources/application.yml': 'server:\n  port: 8084\n' }),
      'api',
    );
    expect(proposal?.spec.config.inject?.SPRING_PROFILES_ACTIVE).toBeUndefined();
    expect(proposal?.spec.port).toBe(8084);
  });

  it('reads a committed example when the real file is gitignored', () => {
    // A fresh worktree has only the example — it still names the profile and
    // the port that profile will use.
    const proposal = detectService(
      repo({
        'build.gradle': gradle,
        'src/main/resources/application.yaml': 'server:\n  port: 5000\n',
        'src/main/resources/config/application-local.example': 'server:\n  port: 5024\n',
      }),
      'content-service',
    );
    expect(proposal?.spec.port).toBe(5024);
    const profile = proposal?.evidence.find((e) => e.field === 'profile');
    expect(profile?.why).toContain('example');
  });

  it('finds a port that is not the first key under server', () => {
    const proposal = detectService(
      repo({
        'build.gradle': gradle,
        'src/main/resources/application.yml': 'server:\n  shutdown: graceful\n  servlet:\n    context-path: /api\n  port: 7070\n',
      }),
      'api',
    );
    expect(proposal?.spec.port).toBe(7070);
  });
});

describe('detectServices — convention plugin applied the old way', () => {
  it('finds a module that says `apply plugin:` rather than `plugins { id }`', () => {
    // orders-svc: the service uses the plugins block, the processor
    // beside it the older spelling. Both are bootable; only one was found.
    const found = detectServices(
      repo({
        'settings.gradle': "include 'orders-service', 'orders-processor'",
        'gradlew': '',
        'build.gradle': "plugins { id 'java' }",
        'orders-service/build.gradle': 'plugins {\n  id "com.acme.microservice"\n}',
        'orders-service/src/main/resources/application.yml': 'server:\n  port: 5016\n',
        'orders-processor/build.gradle': "apply plugin: 'com.acme.microservice'",
        'orders-processor/src/main/resources/application.yml': 'server:\n  port: 5060\n',
      }),
      'orders-svc',
    );
    const commands = found.map((p) => p.spec.command.join(' '));
    expect(commands.some((c) => c.includes(':orders-processor:bootRun'))).toBe(true);
    expect(commands.some((c) => c.includes(':orders-service:bootRun'))).toBe(true);
  });
});
