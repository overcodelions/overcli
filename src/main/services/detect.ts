// Working out how a checkout boots, so you don't have to type it.
//
// Authoring the config is the expensive part of every tool in this space —
// somebody who already understands the whole system spends a week writing it,
// and it rots the moment a service moves. This module does that work from the
// repo instead, and — the part that makes it trustworthy — reports WHY it
// concluded each thing. A proposal you cannot audit is a proposal you won't
// accept on the one day it matters, which is the first one.
//
// A repo is not a service. A multi-module Gradle or Maven build is one
// checkout holding a dozen modules, of which a handful boot and the rest are
// libraries, and treating the root as one service finds nothing you can run.
// So detection enumerates MODULES first and asks the question per module —
// which is also where `subpath` on a spec comes from.
//
// This is the only place in the engine that knows one ecosystem from another.
// Everything downstream — binding, config projection, readiness, ports —
// treats a Spring module and an Apache vhost identically, so a stack nobody
// taught us still works. You just type the command once yourself.

import type { Evidence, ReadinessProbe, ReadyCandidate, RunnerKind, ServiceProposal } from './types';
import { defaultDebugPort, debugKindFor } from './debug';

export type { Evidence, ServiceProposal };

/// Reading a checkout, without caring whether it is on disk or in a test.
export interface RepoReader {
  exists(relativePath: string): boolean;
  read(relativePath: string): string | null;
  /// Names in one directory, empty when it is not one. Optional: only the
  /// ecosystems whose build file has no fixed name (`Api.csproj`) or whose
  /// build lists members by glob (`crates/*`) need it, and a reader without it
  /// just detects less.
  list?(relativeDir: string): string[];
}

/// A reader for one directory of a checkout, so a detector can ask for
/// `Cargo.toml` without knowing which module it is looking at.
function scopedReader(repo: RepoReader, dir: string): RepoReader {
  const at = (relative: string) => (dir ? (relative ? `${dir}/${relative}` : dir) : relative);
  return {
    exists: (relative) => repo.exists(at(relative)),
    read: (relative) => repo.read(at(relative)),
    list: repo.list ? (relative) => repo.list!(at(relative)) : undefined,
  };
}

/// Every service a checkout appears to contain. A single-service repo gives
/// one; a multi-module build gives one per bootable module and nothing for
/// its libraries.
export function detectServices(repo: RepoReader, name: string): ServiceProposal[] {
  const modules = buildModules(repo);
  if (modules.length > 0) {
    const found = modules.flatMap((m) => detectInDirectory(repo, m.dir, m.name, m.gradlePath));
    // A multi-module build whose modules are all libraries is still worth
    // falling through for — the root may be the service after all.
    if (found.length > 0) return found;
  }
  return detectInDirectory(repo, '', name);
}

/// The first service in a checkout, for callers that want just one.
export function detectService(repo: RepoReader, name: string): ServiceProposal | null {
  return detectServices(repo, name)[0] ?? null;
}

/// The proposal that describes an existing service, for asking detection a
/// question about a spec it did not just produce. The same module, launched
/// the same way, wins; then the same port; then the only proposal there is.
export function proposalFor(
  proposals: readonly ServiceProposal[],
  spec: { runner: RunnerKind; subpath?: string; command: readonly string[]; port?: number },
): ServiceProposal | null {
  const sameModule = proposals.filter(
    (p) => p.spec.runner === spec.runner && (p.spec.subpath ?? '') === (spec.subpath ?? ''),
  );
  // A Gradle module is told apart by its task, `:billing-rest:bootRun`.
  const sameTask = sameModule.find((p) => p.spec.command[1] === spec.command[1]);
  if (sameTask) return sameTask;
  if (spec.port !== undefined) {
    const samePort = proposals.find((p) => p.spec.port === spec.port);
    if (samePort) return samePort;
  }
  if (sameModule.length === 1) return sameModule[0];
  return proposals.length === 1 ? proposals[0] : null;
}

// ── module enumeration ──────────────────────────────────────────────────────

interface ModuleRef {
  /// Directory relative to the checkout root.
  dir: string;
  name: string;
  /// Gradle's own path (`billing-rest`, `AcmeTest:AcmeManagersTest`), needed to
  /// build `:module:bootRun`. Absent for Maven.
  gradlePath?: string;
}

/// Modules declared by the build, Gradle or Maven.
export function buildModules(repo: RepoReader): ModuleRef[] {
  const settings =
    repo.read('settings.gradle') ?? repo.read('settings.gradle.kts') ?? null;
  if (settings) {
    return parseGradleIncludes(settings).map((gradlePath) => {
      const dir = gradlePath.split(':').filter(Boolean).join('/');
      return { dir, name: dir.split('/').pop() ?? dir, gradlePath };
    });
  }

  const pom = repo.read('pom.xml');
  if (pom) {
    return parseMavenModules(pom).map((dir) => ({ dir, name: dir.split('/').pop() ?? dir }));
  }

  return [];
}

/// Gradle project paths out of a settings file. Handles the groovy form
/// (`include 'a', 'b:c'`) and the kotlin one (`include(":a", ":b")`), across
/// however many include statements the file has.
export function parseGradleIncludes(settings: string): string[] {
  const out: string[] = [];
  // Anything quoted on a line that starts an include. Deliberately loose:
  // settings files carry plugin blocks and credentials logic we do not want
  // to parse, and a quoted string on an include line is always a project.
  for (const match of settings.matchAll(/^\s*include\s*\(?([^\n]*)/gm)) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const path = quoted[1].replace(/^:/, '').trim();
      if (path) out.push(path);
    }
  }
  return [...new Set(out)];
}

/// `<module>` entries from a Maven aggregator pom.
export function parseMavenModules(pom: string): string[] {
  const block = /<modules>([\s\S]*?)<\/modules>/.exec(pom);
  if (!block) return [];
  return [...block[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
}

// ── per-directory detection ─────────────────────────────────────────────────

/// What, if anything, boots in one directory of the checkout.
function detectInDirectory(
  repo: RepoReader,
  dir: string,
  name: string,
  gradlePath?: string,
): ServiceProposal[] {
  const sub = (relative: string) => (dir ? `${dir}/${relative}` : relative);
  const scoped = scopedReader(repo, dir);

  const spring = detectSpringModule(repo, scoped, dir, name, gradlePath);
  if (spring) return [spring];

  // Server frameworks that ship a package.json for their assets — Rails,
  // Phoenix, Laravel all do, with a `dev` script that runs vite. That script
  // is a helper to the app, not the app, so these are asked before Node is.
  const ruby = detectRuby(scoped, name, dir);
  if (ruby) return [ruby];
  const elixir = detectElixir(scoped, name, dir);
  if (elixir) return [elixir];
  const php = detectPhp(scoped, name, dir);
  if (php) return [php];
  // A deno.json with tasks is a statement of how this runs; a package.json
  // beside it is usually there for editor tooling.
  const deno = detectDeno(scoped, name, dir);
  if (deno) return [deno];

  // A web app can live one level down inside a module (a Gradle module whose
  // package.json is under `src/`), so look there too rather than declaring the
  // module unrunnable.
  for (const nested of ['', 'src', 'web', 'frontend', 'ui']) {
    const nestedDir = nested ? sub(nested) : dir;
    const node = detectNode(scopedReader(repo, nestedDir), name, nestedDir, repo);
    if (node) return [node];
  }

  const python = detectPython(scoped, name, dir);
  if (python) return [python];
  const go = detectGo(scoped, name, dir);
  if (go) return [go];
  const rust = detectRust(scoped, name, dir);
  if (rust.length > 0) return rust;
  const dotnet = detectDotnet(scoped, name, dir);
  if (dotnet.length > 0) return dotnet;
  const compose = detectCompose(scoped, name, dir);
  if (compose) return [compose];
  return [];
}

// ── Spring Boot ─────────────────────────────────────────────────────────────

function detectSpringModule(
  root: RepoReader,
  module: RepoReader,
  dir: string,
  name: string,
  gradlePath?: string,
): ServiceProposal | null {
  const maven = module.exists('pom.xml');
  const gradleFile = module.exists('build.gradle')
    ? 'build.gradle'
    : module.exists('build.gradle.kts')
      ? 'build.gradle.kts'
      : null;
  if (!maven && !gradleFile) return null;

  const buildFile = maven ? 'pom.xml' : (gradleFile as string);
  const build = module.read(buildFile) ?? '';

  // The test that separates a service from a library, and the one that
  // matters most in a big build: `acme-core` and `rest-common` also have
  // spring on the classpath, but only a bootable module has a way to run.
  const declaresBoot = maven
    ? /spring-boot-maven-plugin|spring-boot-starter-web/.test(build)
    : /bootRun\s*\{|apply plugin:\s*['"]org\.springframework\.boot['"]|id\s*\(?\s*['"]org\.springframework\.boot['"]/.test(
        build,
      );

  // Plenty of shops hide Spring behind a convention plugin — a module whose
  // whole build file is `plugins { id "com.acme.microservice" }`, with the
  // boot plugin applied inside it. Nothing in the file names Spring, so the
  // test above says library and twenty real services go missing.
  //
  // An application config is the evidence that settles it: an application has
  // an `application.yml`, a library does not. Narrow enough to stay honest,
  // and it is the same file the port comes from anyway.
  //
  // Either spelling of applying one: orders-service says
  // `plugins { id … }`, its processor beside it says `apply plugin: …`.
  const viaConvention =
    !declaresBoot &&
    !maven &&
    hasApplicationConfig(module) &&
    /plugins\s*\{|apply\s+plugin:/.test(build);

  if (!declaresBoot && !viaConvention) return null;

  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const evidence: Evidence[] = [
    {
      field: 'runner',
      why: viaConvention
        ? 'an application config beside a build that applies a convention plugin'
        : maven
          ? 'spring-boot plugin in the module pom'
          : 'a bootRun task in the module build',
      source: viaConvention ? relative(applicationConfigPath(module) ?? buildFile) : relative(buildFile),
    },
  ];

  // Gradle multi-module builds run from the ROOT with a qualified task path —
  // `./gradlew :billing-rest:bootRun` — not from inside the module. Getting
  // this wrong is the difference between a service that starts and one that
  // cannot resolve its sibling projects.
  const runner: RunnerKind = maven ? 'spring-boot' : 'gradle';
  const wrapper = maven
    ? root.exists('mvnw')
      ? './mvnw'
      : 'mvn'
    : root.exists('gradlew')
      ? './gradlew'
      : 'gradle';
  const command = maven
    ? dir
      ? [wrapper, '-pl', dir, 'spring-boot:run']
      : [wrapper, 'spring-boot:run']
    : [
        wrapper,
        gradlePath ? `:${gradlePath}:bootRun` : 'bootRun',
        // Without this the build runs in a daemon that was started earlier,
        // with an earlier environment — so the variables set for THIS launch
        // never reach the forked JVM. A Spring app then comes up on whatever
        // profile the daemon was born with, silently reads a different
        // properties file, and fails on a placeholder that is defined in the
        // one it should have read. The Tiltfile this was modelled on passes
        // the same flag, for the same reason.
        '-Dorg.gradle.daemon=false',
      ];
  evidence.push({
    field: 'command',
    why: gradlePath
      ? 'a multi-module Gradle build runs from the root with a qualified task'
      : `${wrapper} in the repo root`,
    source: wrapper,
  });

  // Which profile a developer runs this with, from the files that exist. It
  // used to be `local` for every Spring module, whether or not the module had
  // one — and the port was read without regard to it, so a module whose
  // local profile moved it off 5000 was launched expecting 5000.
  const profile = findLocalProfile(module);
  if (profile) {
    evidence.push({
      field: 'profile',
      why: profile.example
        ? `only an example of the ${profile.name} profile is committed — copy it before the first start`
        : `a ${profile.name} profile exists, so that is what runs locally`,
      source: relative(profile.source),
    });
  }

  const found = findSpringPort(module, profile?.name);
  // Only assume a port for something that actually serves. A batch or queue
  // module has no port, and defaulting it to 8080 would invent a clash with
  // whichever module in the same build really is the web app.
  const web =
    /spring-boot-starter-web|apply plugin:\s*['"]war['"]/.test(build) ||
    // Identified by its config: that file is also where a port would be, so
    // trust it rather than the build file that mentions nothing.
    viaConvention;
  const port = found?.port ?? (web ? 8080 : undefined);
  evidence.push({
    field: 'port',
    why: found
      ? found.profile
        ? `server.port in the ${found.profile} profile, which overrides the base config`
        : 'server.port in the module config'
      : web
        ? 'no server.port set — Spring defaults to 8080'
        : 'no web starter — this one does not appear to serve anything',
    source: found ? relative(found.source) : undefined,
  });

  const actuator = /spring-boot-starter-actuator/.test(build);
  const readyCandidates =
    port === undefined
      ? undefined
      : springReadyCandidates({ root, module, relative, build, buildFile, port, profile: profile?.name, actuator });
  const ready: ReadinessProbe = readyCandidates?.[0].probe ?? { kind: 'none' };
  evidence.push({
    field: 'ready',
    why: readyCandidates ? readyCandidates[0].why : 'nothing to probe — ready as soon as it starts',
    source: readyCandidates?.[0].source,
  });

  const devtools = /spring-boot-devtools/.test(build);
  if (devtools) {
    evidence.push({
      field: 'selfReloads',
      why: 'devtools restarts the context itself',
      source: relative(buildFile),
    });
  }

  evidence.push({
    field: 'config',
    why: 'Spring reads an extra config location from env — your local properties stay outside the checkout',
  });

  return {
    spec: {
      name,
      // Something that serves HTTP and something that drains a queue are
      // different kinds of thing to a person, and the list groups by exactly
      // that. Free text, so it can be renamed into whatever this shop calls it.
      group: port === undefined ? 'Processors' : 'REST services',
      // A Gradle module runs from the root, so it has no subpath; anything
      // else runs where it lives.
      subpath: gradlePath ? undefined : dir || undefined,
      runner,
      command,
      port,
      debugKind: debugKindFor({ runner }),
      debugPort: defaultDebugPort(runner, port),
      ready,
      selfReloads: devtools,
      watch: devtools ? undefined : [dir ? `${dir}/src/**` : 'src/**'],
      config: {
        inject: {
          // Only a profile that exists. Activating one that does not is
          // harmless to Spring and misleading to everyone reading the pane.
          ...(profile ? { SPRING_PROFILES_ACTIVE: profile.name } : {}),
          SPRING_CONFIG_ADDITIONAL_LOCATION: '${SERVICE_CONFIG_DIR}/',
        },
      },
    },
    evidence,
    readyCandidates,
    confidence: found ? 'high' : viaConvention ? 'low' : 'medium',
  };
}

/// The application config files Spring reads, in the places projects put them.
const CONFIG_LOCATIONS = ['src/main/resources', 'src/main/resources/config', 'config', '.'];
const CONFIG_FILES = [
  'application-local.properties',
  'application-local.yml',
  'application.properties',
  'application.yml',
  'application.yaml',
];

/// Where this module's application config is, if it has one.
export function applicationConfigPath(module: RepoReader): string | null {
  for (const dir of CONFIG_LOCATIONS) {
    for (const file of CONFIG_FILES) {
      const relative = dir === '.' ? file : `${dir}/${file}`;
      if (module.exists(relative)) return relative;
    }
  }
  return null;
}

function hasApplicationConfig(module: RepoReader): boolean {
  return applicationConfigPath(module) !== null;
}

/// Profiles that mean "on my machine", most conventional first.
const LOCAL_PROFILES = ['local', 'dev', 'development'];

/// Where Spring looks, highest precedence first: a `config/` directory beats
/// its parent, and the working directory beats the classpath. The order is the
/// point — reading the lower-precedence file first is how 5000 won over 5024.
const PRECEDENCE = ['config', '.', 'src/main/resources/config', 'src/main/resources'];
const EXTENSIONS = ['properties', 'yml', 'yaml'];

function at(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

/// The local profile this module is run with, if it has one.
///
/// The real file is usually gitignored — it holds a developer's database and
/// credentials — so a fresh worktree often has only the committed `.example`.
/// That still names the profile, and still shows the port it will use.
export function findLocalProfile(
  module: RepoReader,
): { name: string; source: string; example: boolean } | null {
  for (const name of LOCAL_PROFILES) {
    for (const dir of PRECEDENCE) {
      for (const ext of EXTENSIONS) {
        const file = at(dir, `application-${name}.${ext}`);
        if (module.exists(file)) return { name, source: file, example: false };
      }
    }
    for (const dir of PRECEDENCE) {
      for (const candidate of [
        `application-${name}.example`,
        ...EXTENSIONS.map((ext) => `application-${name}.${ext}.example`),
      ]) {
        const file = at(dir, candidate);
        if (module.exists(file)) return { name, source: file, example: true };
      }
    }
  }
  return null;
}

/// `server.port` from one file, in either syntax.
function portIn(text: string): { port: number; line: number } | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const direct = /^\s*server\.port\s*[:=]\s*(\d+)/.exec(lines[i]);
    if (direct) return { port: Number(direct[1]), line: i + 1 };

    // YAML: `port:` anywhere inside the `server:` block, not just on the next
    // line — `servlet:` or `shutdown:` commonly come first.
    const block = /^(\s*)server\s*:\s*$/.exec(lines[i]);
    if (!block) continue;
    const indent = block[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
      const own = /^(\s*)/.exec(lines[j])![1].length;
      if (own <= indent) break;
      const nested = /^\s+port\s*:\s*(\d+)/.exec(lines[j]);
      if (nested) return { port: Number(nested[1]), line: j + 1 };
    }
  }
  return null;
}

/// `server.port` as Spring would resolve it: the active profile's file first,
/// in any location, then the base config.
function findSpringPort(
  module: RepoReader,
  profile?: string,
): { port: number; source: string; profile?: string } | null {
  const search = (names: string[], tag?: string) => {
    for (const dir of PRECEDENCE) {
      for (const name of names) {
        const file = at(dir, name);
        const text = module.read(file);
        if (!text) continue;
        const hit = portIn(text);
        if (hit) return { port: hit.port, source: `${file}:${hit.line}`, profile: tag };
      }
    }
    return null;
  };

  if (profile) {
    const own = search(
      [
        ...EXTENSIONS.map((ext) => `application-${profile}.${ext}`),
        `application-${profile}.example`,
        ...EXTENSIONS.map((ext) => `application-${profile}.${ext}.example`),
      ],
      profile,
    );
    if (own) return own;
  }
  return search(EXTENSIONS.map((ext) => `application.${ext}`));
}

// ── Spring readiness ────────────────────────────────────────────────────────
//
// "The actuator starter is on the classpath, so probe /actuator/health" is
// right for a fresh Boot 3 app and wrong for most of the ones that have been
// around a while. Boot 1 serves the endpoint at `/health`; a
// `management.context-path` moves it; a `management.port` moves it to another
// port entirely; and an app with its own security filter answers 401 to
// anything not on its anonymous list. Each of those turned a working service
// into one that read "unready" forever while the probe filled its log with a
// stack trace per attempt.
//
// So the probe is chosen from what the code says, as a ranked list of
// candidates, each with the file that suggested it — and the list is kept, so
// the ready editor can offer the runner-up when the first guess is wrong.

/// Path segments that name a liveness endpoint when a controller maps them.
const HEALTHY_NAMES = new Set(['status', 'health', 'healthcheck', 'healthz', 'ping', 'heartbeat', 'alive']);

/// How far a source walk goes. Detection runs on import over whole checkouts;
/// a monolith with ten thousand classes must not stall it.
const WALK_MAX_ENTRIES = 4_000;
const WALK_MAX_READS = 400;

interface Found {
  value: string;
  source: string;
}

interface Ranked extends ReadyCandidate {
  score: number;
}

export interface SpringReadyInput {
  root: RepoReader;
  module: RepoReader;
  /// Module-relative path to checkout-relative, for evidence.
  relative(file: string): string;
  build: string;
  buildFile: string;
  port: number;
  profile?: string;
  actuator: boolean;
}

/// Every probe worth considering for a Spring module, best first. Never empty:
/// the port opening is always a candidate, and the floor.
export function springReadyCandidates(input: SpringReadyInput): ReadyCandidate[] {
  const { module, relative, port } = input;
  const prop = (...keys: string[]) => {
    const found = springProperty(module, input.profile, keys);
    return found ? { ...found, source: relative(found.source) } : null;
  };
  const version = springBootVersion(input.root, module, input.build, input.buildFile, relative);
  const security = springSecurity(module, input.build, relative);
  const anonymous = (path: string) => security.anonymous.find((a) => antMatches(a.pattern, path));
  const ranked: Ranked[] = [];

  const serverContext = prop('server.servlet.context-path', 'server.context-path');
  const appPrefix = trimSlash(serverContext?.value ?? '');

  // Controllers that map something that sounds like a liveness endpoint.
  const seen = new Set<string>();
  for (const mapping of controllerHealthMappings(module, relative)) {
    // A path variable cannot be probed, and `/partners/{id}/status` is a
    // business endpoint that happens to end in a liveness word.
    if (seen.has(mapping.value) || mapping.value.includes('{')) continue;
    const open = anonymous(mapping.value);
    // Nested and behind a login (`/connectors/slack/status`) is about
    // something else; only a top-level one is worth offering unprotected.
    if (!open && mapping.value.split('/').filter(Boolean).length > 1) continue;
    seen.add(mapping.value);
    ranked.push({
      probe: { kind: 'http', port, path: appPrefix + mapping.value },
      why: open
        ? `a controller maps ${mapping.value}, and the security config lets anyone reach it (${open.source})`
        : security.secured
          ? `a controller maps ${mapping.value}, but the app is secured and nothing marks it anonymous — likely a 401`
          : `a controller maps ${mapping.value}`,
      source: mapping.source,
      score: open ? 100 : security.secured ? 20 : 60,
    });
  }

  // An anonymous exact path that names a liveness endpoint, even without the
  // controller in this module — it often lives in a shared library.
  for (const open of security.anonymous) {
    const path = open.pattern;
    if (!/^\/[\w\-/]*$/.test(path) || seen.has(path)) continue;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    if (!HEALTHY_NAMES.has(last.toLowerCase())) continue;
    seen.add(path);
    ranked.push({
      probe: { kind: 'http', port, path: appPrefix + path },
      why: `the security config lets anyone reach ${path}`,
      source: open.source,
      score: 80,
    });
  }

  if (input.actuator) {
    const managementPort = numberOf(prop('management.server.port', 'management.port'));
    const separate = managementPort !== undefined && managementPort > 0 && managementPort !== port;
    const probePort = separate ? managementPort : port;
    const portNote = separate ? ` on the management port (${prop('management.server.port', 'management.port')?.source})` : '';

    const paths: { path: string; why: string; source?: string; sure: boolean }[] = [];
    if (version && version.major === 1) {
      const context = prop('management.context-path', 'management.contextpath');
      const base = trimSlash(context?.value ?? '');
      paths.push({
        path: `${base}/health`,
        why: context
          ? `Spring Boot ${version.value} serves health at /health, under management.context-path ${base}`
          : `Spring Boot ${version.value} serves health at /health, not /actuator/health`,
        source: context?.source ?? version.source,
        sure: true,
      });
    } else {
      const basePath = prop('management.endpoints.web.base-path');
      const managementContext = separate
        ? prop('management.server.servlet.context-path', 'management.server.base-path')
        : null;
      const base = basePath ? trimSlash(basePath.value) : '/actuator';
      const prefix = trimSlash(managementContext?.value ?? '');
      paths.push({
        path: `${prefix}${base}/health`,
        why: version
          ? basePath || managementContext
            ? `Spring Boot ${version.value} with a configured actuator path`
            : `Spring Boot ${version.value} serves health at /actuator/health`
          : 'actuator starter present',
        source: basePath?.source ?? managementContext?.source ?? version?.source ?? relative(input.buildFile),
        sure: version !== null,
      });
      if (!version) {
        paths.push({
          path: '/health',
          why: 'actuator starter present — /health if this is Spring Boot 1.x',
          source: relative(input.buildFile),
          sure: false,
        });
      }
    }

    for (const { path, why, source, sure } of paths) {
      // The app's own prefix applies when the actuator shares its port.
      const full = (separate ? '' : appPrefix) + path;
      const open = anonymous(path) ?? (security.actuatorOpen ? { pattern: path, source: security.actuatorOpen } : undefined);
      const reachable = !security.secured || !!open;
      ranked.push({
        probe: { kind: 'http', port: probePort, path: full },
        why: reachable
          ? `${why}${portNote}${open ? `, and the security config lets anyone reach it (${open.source})` : ''}`
          : `${why}${portNote}, but the app is secured and nothing marks it anonymous — likely a 401`,
        source,
        score: reachable ? (sure ? 90 : path === '/health' ? 40 : 70) : 15,
      });
    }
  }

  ranked.push({
    probe: { kind: 'tcp', port },
    why: ranked.length === 0
      ? input.actuator
        ? 'the port accepting a connection'
        : 'no actuator — falling back to the port opening'
      : 'the port accepting a connection — passes whatever is secured, but before the app can answer',
    score: 30,
  });

  // Stable: equal scores keep the order they were found in.
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r: { probe, why, source } }) => (source ? { probe, why, source } : { probe, why }));
}

function trimSlash(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function numberOf(found: Found | null): number | undefined {
  if (!found) return undefined;
  const n = Number(found.value);
  return Number.isInteger(n) ? n : undefined;
}

/// Whether an Ant-style pattern (`/manage/**`, `/a/*/b`) covers a path.
export function antMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  // `/manage/**` covers `/manage` itself, as Spring's matcher does.
  return new RegExp(`^${source.replace(/\/\.\*$/, '(?:/.*)?')}$`).test(path);
}

/// A Spring property as the active profile would see it: the profile's file
/// first, then the base config, in Spring's own location order. Keys compare
/// the way relaxed binding does — `context-path`, `contextPath` and
/// `context_path` are one key.
export function springProperty(module: RepoReader, profile: string | undefined, keys: readonly string[]): Found | null {
  const wanted = new Set(keys.map(relaxedKey));
  const names = [
    ...(profile ? EXTENSIONS.map((ext) => `application-${profile}.${ext}`) : []),
    ...EXTENSIONS.map((ext) => `application.${ext}`),
  ];
  for (const name of names) {
    for (const dir of PRECEDENCE) {
      const file = at(dir, name);
      const text = module.read(file);
      if (!text) continue;
      for (const entry of flattenConfig(text)) {
        if (!wanted.has(relaxedKey(entry.key))) continue;
        const value = resolvePlaceholder(entry.value);
        if (value !== null) return { value, source: `${file}:${entry.line}` };
      }
    }
  }
  return null;
}

function relaxedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/// `${PORT:8080}` reads as its default; `${PORT}` is unknowable from here.
function resolvePlaceholder(value: string): string | null {
  const placeholder = /^\$\{[^:}]+(?::([^}]*))?\}$/.exec(value);
  if (placeholder) return placeholder[1] ?? null;
  return value.includes('${') ? null : value;
}

/// Every `key = value` in a properties file or a YAML one, as dotted keys.
/// Deliberately small: enough YAML for nested maps of scalars, which is all a
/// Spring config uses for the keys asked about here.
export function flattenConfig(text: string): { key: string; value: string; line: number }[] {
  const out: { key: string; value: string; line: number }[] = [];
  const stack: { indent: number; key: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('-')) continue;
    const m = /^(\s*)([^:=\s][^:=]*?)\s*[:=]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = [...stack.map((s) => s.key), m[2].trim()].join('.');
    const value = m[3].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value === '') stack.push({ indent, key: m[2].trim() });
    else out.push({ key, value, line: i + 1 });
  }
  return out;
}

/// The Spring Boot version the module builds against, from the first place
/// that names it: the module build, the root build, a version catalog, and a
/// `$property` resolved through `gradle.properties` or a Maven property.
export function springBootVersion(
  root: RepoReader,
  module: RepoReader,
  build: string,
  buildFile: string,
  relative: (file: string) => string,
): { value: string; major: number; source: string } | null {
  const files: { text: string; source: string }[] = [{ text: build, source: relative(buildFile) }];
  for (const file of ['build.gradle', 'build.gradle.kts', 'pom.xml', 'gradle/libs.versions.toml']) {
    const text = root.read(file);
    if (text && relative(buildFile) !== file) files.push({ text, source: file });
  }
  const patterns = [
    /spring-boot-starter-parent<\/artifactId>\s*<version>\s*([^<\s]+)/,
    /<spring-boot\.version>\s*([^<\s]+)/,
    /id\s*\(?\s*['"]org\.springframework\.boot['"]\s*\)?\s*version\s*['"]([^'"]+)['"]/,
    /spring-boot-gradle-plugin:([^'"\s)]+)/,
    /springBootVersion\s*=\s*['"]([^'"]+)['"]/,
    /^\s*spring-?[bB]oot\s*=\s*"([^"]+)"/m,
    // A starter pinned on its own — the weakest hint, so last.
    /org\.springframework\.boot:spring-boot-starter[\w-]*:(\d[^'"\s)]*)/,
  ];
  for (const pattern of patterns) {
    for (const { text, source } of files) {
      const m = pattern.exec(text);
      if (!m) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const resolved = resolveBuildVariable(m[1], root, module, files);
      if (!resolved) continue;
      const major = Number(/^(\d+)/.exec(resolved.value)?.[1]);
      if (!Number.isFinite(major)) continue;
      return { value: resolved.value, major, source: resolved.source ?? `${source}:${line}` };
    }
  }
  return null;
}

/// `$springBootVersion`, `${spring.boot.version}` — looked up where builds keep
/// them. A literal comes back as itself.
function resolveBuildVariable(
  raw: string,
  root: RepoReader,
  module: RepoReader,
  files: readonly { text: string; source: string }[],
): { value: string; source?: string } | null {
  const variable = /^\$\{?([\w.]+)\}?$/.exec(raw);
  if (!variable) return { value: raw };
  // Every metacharacter escaped, not just the dot the pattern above allows:
  // the name goes into a RegExp, and an escape that trusts the shape of its
  // input is one edit away from being wrong.
  const name = variable[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lookups: { text: string | null; source: string }[] = [
    { text: module.read('gradle.properties'), source: 'gradle.properties' },
    { text: root.read('gradle.properties'), source: 'gradle.properties' },
    ...files,
  ];
  const definitions = [
    new RegExp(`^\\s*${name}\\s*[=:]\\s*['"]?([^'"\\s]+)`, 'm'),
    new RegExp(`<${name}>\\s*([^<\\s]+)`),
    new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`),
  ];
  for (const { text, source } of lookups) {
    if (!text) continue;
    for (const definition of definitions) {
      const m = definition.exec(text);
      if (m) return { value: m[1], source: `${source}:${text.slice(0, m.index).split('\n').length}` };
    }
  }
  return null;
}

interface SpringSecurity {
  /// Whether anything in the module puts a login in front of requests.
  secured: boolean;
  /// Ant patterns anyone may reach, with where each was declared.
  anonymous: { pattern: string; source: string }[];
  /// Where Java config opens the health endpoint by name
  /// (`EndpointRequest.to("health")`), which no path pattern would show.
  actuatorOpen?: string;
}

/// What the module's security config lets through without a login — from
/// Spring Security XML and from Java/Kotlin `HttpSecurity` config.
export function springSecurity(module: RepoReader, build: string, relative: (f: string) => string): SpringSecurity {
  const anonymous: { pattern: string; source: string }[] = [];
  let secured = /spring-boot-starter-security|spring-security/.test(build);
  let actuatorOpen: string | undefined;

  const xmlFiles = ['src/main/resources', 'src/main/webapp/WEB-INF'].flatMap((dir) =>
    walk(module, dir, (name) => name.endsWith('.xml')),
  );
  for (const file of xmlFiles.slice(0, WALK_MAX_READS)) {
    const text = module.read(file);
    if (!text || !/springframework\.org\/schema\/security|<(?:\w+:)?(?:filter-chain|intercept-url|http)\b/.test(text)) continue;
    let found = false;
    for (const m of text.matchAll(/<(?:\w+:)?(filter-chain|intercept-url|http)\b([^>]*)>/g)) {
      found = true;
      const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]]));
      const pattern = attrs.pattern;
      if (!pattern) continue;
      const open =
        m[1] === 'filter-chain'
          ? attrs.filters === 'none' ||
            (/anonymous/i.test(attrs.filters ?? '') && !/SecurityInterceptor/i.test(attrs.filters ?? ''))
          : m[1] === 'intercept-url'
            ? /ROLE_ANONYMOUS|IS_AUTHENTICATED_ANONYMOUSLY|permitAll/.test(attrs.access ?? '')
            : attrs.security === 'none';
      if (open) {
        const line = text.slice(0, m.index).split('\n').length;
        anonymous.push({ pattern, source: `${relative(file)}:${line}` });
      }
    }
    if (found) secured = true;
  }

  for (const file of sourceFiles(module, /(Security|Config|Configuration|Application)\w*\.(java|kt)$/)) {
    const text = module.read(file);
    if (!text || !/HttpSecurity|WebSecurity|SecurityFilterChain/.test(text)) continue;
    secured = true;
    const lineOf = (index: number) => `${relative(file)}:${text.slice(0, index).split('\n').length}`;
    for (const m of text.matchAll(
      /(?:antMatchers|requestMatchers|mvcMatchers|regexMatchers|pathMatchers)\s*\(([^)]*)\)\s*\.\s*permitAll\s*\(\s*\)/g,
    )) {
      for (const literal of m[1].matchAll(/"([^"]+)"/g)) anonymous.push({ pattern: literal[1], source: lineOf(m.index) });
    }
    for (const m of text.matchAll(/\.ignoring\s*\(\s*\)\s*\.\s*(?:antMatchers|requestMatchers|mvcMatchers)\s*\(([^)]*)\)/g)) {
      for (const literal of m[1].matchAll(/"([^"]+)"/g)) anonymous.push({ pattern: literal[1], source: lineOf(m.index) });
    }
    const anyRequest = /anyRequest\s*\(\s*\)\s*\.\s*permitAll/.exec(text);
    if (anyRequest) anonymous.push({ pattern: '/**', source: lineOf(anyRequest.index) });
    const endpoint = /EndpointRequest\s*\.\s*(?:to\s*\([^)]*health|toAnyEndpoint)[\s\S]{0,80}?permitAll/.exec(text);
    if (endpoint) actuatorOpen = lineOf(endpoint.index);
  }

  return { secured, anonymous, actuatorOpen };
}

/// Controller mappings that name a liveness endpoint (`/status`, `/health`,
/// `/ping` …), each with the file and line that maps it.
export function controllerHealthMappings(module: RepoReader, relative: (f: string) => string): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles(module, /(Controller|Resource|Endpoint|Health|Status|Ping|Api)\w*\.(java|kt)$/)) {
    const text = module.read(file);
    if (!text || !/@(?:Rest)?Controller\b/.test(text)) continue;
    const classAt = /\bclass\s+\w+/.exec(text)?.index ?? 0;
    const mappings = [...text.matchAll(/@(RequestMapping|GetMapping)\b\s*(?:\(([^)]*)\))?/g)];
    const classLevel = mappings.filter((m) => m.index < classAt && m[1] === 'RequestMapping');
    const methodLevel = mappings.filter((m) => m.index > classAt);
    const prefixes = classLevel.length > 0 ? classLevel.flatMap((m) => mappingPaths(m[2])) : [''];
    const methods = methodLevel.length > 0 ? methodLevel : [null];
    for (const method of methods) {
      for (const tail of method ? mappingPaths(method[2]) : ['']) {
        for (const prefix of prefixes) {
          const path = `${trimSlash(prefix)}${trimSlash(tail)}` || '/';
          const last = path.split('/').filter(Boolean).pop() ?? '';
          if (!HEALTHY_NAMES.has(last.toLowerCase())) continue;
          const index = method?.index ?? classLevel[0]?.index ?? 0;
          out.push({ value: path, source: `${relative(file)}:${text.slice(0, index).split('\n').length}` });
        }
      }
    }
  }
  return out;
}

/// The paths a mapping annotation's arguments name. No arguments, or only a
/// `method =`, maps the empty path.
function mappingPaths(args: string | undefined): string[] {
  if (!args || !args.trim()) return [''];
  const keyed = /\b(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(args);
  const scope = keyed ? keyed[1] : /^\s*(\{[^}]*\}|"[^"]*")/.exec(args)?.[1];
  if (scope === undefined) return [''];
  const literals = [...scope.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return literals.length > 0 ? literals : [''];
}

/// Source files under the usual roots whose names pass `name`, bounded.
function sourceFiles(module: RepoReader, name: RegExp): string[] {
  return ['src/main/java', 'src/main/kotlin']
    .flatMap((dir) => walk(module, dir, (file) => name.test(file)))
    .slice(0, WALK_MAX_READS);
}

/// Files under `dir` whose names pass `accept`, breadth-first and bounded. A
/// name with a dot is taken for a file and anything else for a directory —
/// true of source trees, and it saves a stat per entry.
function walk(module: RepoReader, dir: string, accept: (name: string) => boolean): string[] {
  if (!module.list) return [];
  const out: string[] = [];
  const queue = [dir];
  let entries = 0;
  while (queue.length > 0 && entries < WALK_MAX_ENTRIES) {
    const current = queue.shift() as string;
    for (const name of module.list(current)) {
      if (++entries > WALK_MAX_ENTRIES) break;
      const full = `${current}/${name}`;
      if (name.includes('.')) {
        if (accept(name)) out.push(full);
      } else {
        queue.push(full);
      }
    }
  }
  return out;
}

// ── Node ────────────────────────────────────────────────────────────────────

function detectNode(repo: RepoReader, name: string, dir: string, root: RepoReader): ServiceProposal | null {
  const raw = repo.read('package.json');
  if (!raw) return null;
  let pkg: { scripts?: Record<string, string>; name?: string; packageManager?: string };
  try {
    pkg = JSON.parse(raw) as { scripts?: Record<string, string>; name?: string; packageManager?: string };
  } catch {
    return null;
  }
  const scripts = pkg.scripts ?? {};
  const angular = repo.exists('angular.json');
  const viteConfig = VITE_CONFIGS.find((f) => repo.exists(f));
  const vite = viteConfig !== undefined;
  const script = ['dev', 'start', 'serve'].find((s) => scripts[s]);
  if (!script && !angular) return null;

  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const runner: RunnerKind = angular ? 'ng-serve' : vite ? 'vite' : 'npm';
  // Running a pnpm project through npm is not a style choice: npm ignores the
  // pnpm lockfile, resolves its own tree, and a workspace's `workspace:*`
  // links do not resolve at all.
  const manager = nodePackageManager(root, dir, pkg.packageManager);
  const command = runScript(manager.name, script ?? 'start');

  // The default is only a guess, and a wrong guess is worse than none: the
  // port-owner check then goes looking on the wrong port and names whatever
  // happens to be there — which, for a second vite app, is usually overcli's
  // own dev server. So read what the project actually says first.
  const flagged = script ? portInScript(scripts[script]) : null;
  const configured = !flagged && viteConfig ? viteConfigPort(repo.read(viteConfig) ?? '') : null;
  const port = flagged ?? configured?.port ?? (angular ? 4200 : vite ? 5173 : 3000);
  const portEvidence: Evidence = flagged
    ? { field: 'port', why: `the port flag in scripts.${script}`, source: relative('package.json') }
    : configured && viteConfig
      ? { field: 'port', why: 'server.port in the vite config', source: `${relative(viteConfig)}:${configured.line}` }
      : { field: 'port', why: `${runner} default — no port found in the config` };

  return {
    spec: {
      name,
      group: 'Front ends',
      subpath: dir || undefined,
      runner,
      command,
      port,
      debugKind: debugKindFor({ runner }),
      debugPort: defaultDebugPort(runner, port),
      // A dev server's own "compiled" line is a better readiness signal than
      // the port, which opens before the first build finishes.
      ready: angular || vite
        ? { kind: 'log', pattern: angular ? 'Compiled successfully|Application bundle generation complete' : 'ready in' }
        : { kind: 'tcp', port },
      selfReloads: true,
      config: { link: { '.env.local': '${SERVICE_CONFIG_DIR}/.env.local' } },
    },
    evidence: [
      {
        field: 'runner',
        why: angular ? 'angular.json alongside the package' : vite ? 'a vite config' : `a "${script}" script`,
        source: relative(angular ? 'angular.json' : 'package.json'),
      },
      { field: 'command', why: `package.json scripts.${script ?? 'start'}`, source: relative('package.json') },
      {
        field: 'command',
        why: manager.source
          ? `${manager.name}, from ${manager.why}`
          : 'npm — no pnpm, yarn or bun lockfile found',
        source: manager.source,
      },
      portEvidence,
      {
        field: 'selfReloads',
        why: 'the dev server watches and reloads itself — overcli will not restart it on change',
      },
      { field: 'config', why: '.env.local is linked in from your service config folder' },
    ],
    confidence: 'medium',
  };
}

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

/// Which package manager a Node project is run with. The lockfile decides,
/// looked for beside the package.json and then in each directory above it — a
/// workspace keeps one lockfile at its root, not one per package. The
/// `packageManager` field (corepack's) is the fallback for a checkout whose
/// lockfile is not committed.
export function nodePackageManager(
  root: RepoReader,
  dir: string,
  declared?: string,
): { name: PackageManager; why?: string; source?: string } {
  const parts = dir ? dir.split('/') : [];
  for (let depth = parts.length; depth >= 0; depth--) {
    const base = parts.slice(0, depth).join('/');
    for (const [file, name] of LOCKFILES) {
      const path = base ? `${base}/${file}` : file;
      if (root.exists(path)) return { name, why: `the ${file} lockfile`, source: path };
    }
  }
  const field = /^(pnpm|yarn|bun|npm)@/.exec(declared ?? '');
  if (field) {
    const name = field[1] as PackageManager;
    return { name, why: 'the packageManager field', source: dir ? `${dir}/package.json` : 'package.json' };
  }
  return { name: 'npm' };
}

/// How each manager runs a package script. yarn is the one where the bare
/// script name is the idiom; the others keep `run`, so a script can never be
/// shadowed by a built-in command of the same name.
function runScript(manager: PackageManager, script: string): string[] {
  return manager === 'yarn' ? ['yarn', script] : [manager, 'run', script];
}

/// A port named on the command line of a package script: `vite --port 5273`,
/// `ng serve --port=4300`, `PORT=3001 next dev`.
export function portInScript(body: string | undefined): number | null {
  if (!body) return null;
  const match = /--port[=\s]+(\d{2,5})\b/.exec(body) ?? /\bPORT=(\d{2,5})\b/.exec(body);
  return match ? Number(match[1]) : null;
}

/// `server: { port }` out of a vite config, with the line it is on.
///
/// A regex over source rather than evaluating the config: running a project's
/// build file to learn one number is a lot of trust to extend at detect time.
/// `preview.port` is deliberately skipped — it is not the dev server.
export function viteConfigPort(text: string): { port: number; line: number } | null {
  const uncommented = text.replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
  const server = /\bserver\s*:\s*\{/.exec(uncommented);
  if (!server) return null;

  // Only inside the server block: walk braces to where it closes.
  let depth = 0;
  const from = server.index + server[0].length - 1;
  let end = uncommented.length;
  for (let i = from; i < uncommented.length; i++) {
    if (uncommented[i] === '{') depth++;
    else if (uncommented[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const block = uncommented.slice(from, end);
  const port = /(?:^|[\s,{])port\s*:\s*(\d{2,5})\b/.exec(block);
  if (!port) return null;
  const offset = from + port.index;
  return { port: Number(port[1]), line: text.slice(0, offset).split('\n').length };
}

// ── Python ──────────────────────────────────────────────────────────────────

function detectPython(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const django = repo.exists('manage.py');
  const pyproject = repo.read('pyproject.toml') ?? '';
  const requirements = repo.read('requirements.txt') ?? '';
  const deps = `${pyproject}\n${requirements}`;
  const fastapi = /fastapi|uvicorn/i.test(deps);
  const flask = /\bflask\b/i.test(deps);
  if (!django && !fastapi && !flask) return null;

  const subpath = dir || undefined;
  if (django) {
    return {
      spec: {
        name,
        group: 'Services',
        subpath,
        runner: 'python',
        command: ['python', 'manage.py', 'runserver'],
        port: 8000,
        debugKind: 'debugpy',
        debugPort: 5678,
        ready: { kind: 'tcp', port: 8000 },
        selfReloads: true,
        config: { inject: { DJANGO_SETTINGS_MODULE: 'config.settings.local' } },
      },
      evidence: [
        { field: 'runner', why: 'manage.py in the project root', source: dir ? `${dir}/manage.py` : 'manage.py' },
        { field: 'command', why: 'Django dev server' },
        { field: 'port', why: 'runserver defaults to 8000' },
        { field: 'selfReloads', why: 'the dev server reloads on change itself' },
      ],
      confidence: 'medium',
    };
  }

  const command = fastapi ? ['uvicorn', 'app.main:app', '--reload'] : ['flask', 'run'];
  const port = fastapi ? 8000 : 5000;
  const pythonWatch = [dir ? `${dir}/**/*.py` : '**/*.py'];
  return {
    spec: {
      name,
      group: 'Services',
      subpath,
      runner: 'python',
      command,
      port,
      debugKind: 'debugpy',
      debugPort: 5678,
      ready: { kind: 'tcp', port },
      // uvicorn was explicitly launched with --reload. Plain `flask run`
      // was not: its reloader depends on debug mode, which detection cannot
      // assume, so Overcli owns restarts for Python edits in that case.
      selfReloads: fastapi,
      watch: fastapi ? undefined : pythonWatch,
      config: { link: { '.env': '${SERVICE_CONFIG_DIR}/.env' } },
    },
    evidence: [
      {
        field: 'runner',
        why: fastapi ? 'fastapi/uvicorn in the dependencies' : 'flask in the dependencies',
        source: pyproject ? 'pyproject.toml' : 'requirements.txt',
      },
      { field: 'command', why: 'guessed module path — check this one' },
      { field: 'port', why: `${fastapi ? 'uvicorn' : 'flask'} default` },
      {
        field: 'selfReloads',
        why: fastapi
          ? 'uvicorn starts with --reload — overcli will leave it alone'
          : 'plain flask run does not promise a reloader — overcli restarts it on Python changes',
      },
      { field: 'config', why: '.env is linked in from your service config folder' },
    ],
    confidence: 'low',
  };
}

// ── Go ──────────────────────────────────────────────────────────────────────

function detectGo(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  if (!repo.exists('go.mod')) return null;
  const hasCmd = repo.exists('cmd');
  return {
    spec: {
      name,
      group: 'Services',
      subpath: dir || undefined,
      runner: 'go',
      command: hasCmd ? ['go', 'run', './cmd/...'] : ['go', 'run', '.'],
      debugKind: 'delve',
      debugPort: 2345,
      ready: { kind: 'none' },
      selfReloads: false,
      watch: ['**/*.go'],
      config: {},
    },
    evidence: [
      { field: 'runner', why: 'go.mod in the project root', source: dir ? `${dir}/go.mod` : 'go.mod' },
      { field: 'command', why: hasCmd ? 'cmd/ directory present' : 'package in the project root' },
      { field: 'ready', why: 'no port found — nothing to probe until you set one' },
    ],
    confidence: 'low',
  };
}

/// The first number a pattern captures, with the line it is on — so a port read
/// out of a config can say exactly where it came from.
function numberIn(text: string, pattern: RegExp): { value: number; line: number } | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const offset = match.index + match[0].lastIndexOf(match[1]);
  return { value: Number(match[1]), line: text.slice(0, offset).split('\n').length };
}

// ── Ruby ────────────────────────────────────────────────────────────────────

function detectRuby(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const gemfile = repo.read('Gemfile');
  if (gemfile === null) return null;
  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const subpath = dir || undefined;

  if (repo.exists('bin/rails')) {
    const namesRails = /^\s*gem\s+['"]rails['"]/m.test(gemfile);
    // Every generated Rails app has `port ENV.fetch("PORT") { 3000 }` in its
    // puma config, and that is the number someone edits to move it.
    const puma = repo.read('config/puma.rb');
    const found = puma ? numberIn(puma, /^\s*port\b[^\n]*?\b(\d{2,5})\b/m) : null;
    const port = found?.value ?? 3000;
    return {
      spec: {
        name,
        group: 'Services',
        subpath,
        runner: 'command',
        command: ['bin/rails', 'server'],
        port,
        ready: { kind: 'tcp', port },
        // Rails reloads application code inside the running process, but not
        // config, initializers or gems. Restarting on every model edit would
        // pay a full boot for nothing, so only what Rails cannot reload
        // restarts it.
        selfReloads: false,
        watch: [relative('config/**'), relative('Gemfile.lock')],
        config: {},
      },
      evidence: [
        {
          field: 'runner',
          why: namesRails ? 'bin/rails, and rails in the Gemfile' : 'bin/rails in the project root',
          source: relative(namesRails ? 'Gemfile' : 'bin/rails'),
        },
        { field: 'command', why: 'the Rails dev server' },
        found
          ? { field: 'port', why: 'the port in the puma config', source: `${relative('config/puma.rb')}:${found.line}` }
          : { field: 'port', why: 'rails server defaults to 3000' },
        { field: 'selfReloads', why: 'app code reloads in place; config and gem changes need a restart' },
      ],
      confidence: namesRails && found ? 'high' : 'medium',
    };
  }

  if (!repo.exists('config.ru')) return null;
  return {
    spec: {
      name,
      group: 'Services',
      subpath,
      runner: 'command',
      command: ['bundle', 'exec', 'rackup'],
      port: 9292,
      ready: { kind: 'tcp', port: 9292 },
      selfReloads: false,
      watch: [relative('**/*.rb'), relative('config.ru')],
      config: {},
    },
    evidence: [
      { field: 'runner', why: 'config.ru beside a Gemfile — a Rack app', source: relative('config.ru') },
      { field: 'command', why: 'rackup through bundler, so the Gemfile versions are the ones loaded' },
      { field: 'port', why: 'rackup defaults to 9292' },
    ],
    confidence: 'medium',
  };
}

// ── Elixir ──────────────────────────────────────────────────────────────────

function detectElixir(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const mix = repo.read('mix.exs');
  if (mix === null) return null;
  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const subpath = dir || undefined;

  if (/\{\s*:phoenix\s*,/.test(mix)) {
    // The endpoint's `http: [ip: ..., port: 4000]` in the dev config — also
    // the `String.to_integer(System.get_env("PORT") || "4000")` form.
    const dev = repo.read('config/dev.exs');
    const found = dev ? numberIn(dev, /http:\s*\[[^\]]*?port:[^\d\]]*?(\d{2,5})/) : null;
    const port = found?.value ?? 4000;
    return {
      spec: {
        name,
        group: 'Services',
        subpath,
        runner: 'command',
        command: ['mix', 'phx.server'],
        port,
        ready: { kind: 'tcp', port },
        selfReloads: true,
        config: {},
      },
      evidence: [
        { field: 'runner', why: 'phoenix in the mix dependencies', source: relative('mix.exs') },
        { field: 'command', why: 'the Phoenix dev server' },
        found
          ? { field: 'port', why: 'the endpoint port in the dev config', source: `${relative('config/dev.exs')}:${found.line}` }
          : { field: 'port', why: 'Phoenix defaults to 4000' },
        { field: 'selfReloads', why: 'the code reloader recompiles on the next request — overcli will not restart it' },
      ],
      confidence: 'high',
    };
  }

  return {
    spec: {
      name,
      group: 'Services',
      subpath,
      runner: 'command',
      command: ['mix', 'run', '--no-halt'],
      ready: { kind: 'none' },
      selfReloads: false,
      watch: [relative('lib/**'), relative('config/**')],
      config: {},
    },
    evidence: [
      { field: 'runner', why: 'mix.exs in the project root', source: relative('mix.exs') },
      // Plenty of mix projects are libraries; nothing in mix.exs says whether
      // this one starts an application that stays up.
      { field: 'command', why: 'starts the application and keeps it running — check it has one' },
      { field: 'ready', why: 'no port found — nothing to probe until you set one' },
    ],
    confidence: 'low',
  };
}

// ── PHP ─────────────────────────────────────────────────────────────────────

function detectPhp(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const composer = repo.read('composer.json');
  if (composer === null) return null;
  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const subpath = dir || undefined;
  const laravel = repo.exists('artisan');
  const symfony = /"symfony\/framework-bundle"/.test(composer);
  if (!laravel && !symfony) return null;

  // PHP reads the source on every request, so an edit is live without
  // restarting anything — the definition of leaving it alone.
  const reloads: Evidence = { field: 'selfReloads', why: 'PHP reads the source on each request — nothing to restart' };

  if (laravel) {
    const named = /"laravel\/framework"/.test(composer);
    return {
      spec: {
        name,
        group: 'Services',
        subpath,
        runner: 'command',
        command: ['php', 'artisan', 'serve'],
        port: 8000,
        ready: { kind: 'tcp', port: 8000 },
        selfReloads: true,
        config: { link: { '.env': '${SERVICE_CONFIG_DIR}/.env' } },
      },
      evidence: [
        {
          field: 'runner',
          why: named ? 'artisan, and laravel/framework in composer.json' : 'an artisan file in the project root',
          source: relative(named ? 'composer.json' : 'artisan'),
        },
        { field: 'command', why: 'the Laravel dev server' },
        { field: 'port', why: 'artisan serve defaults to 8000' },
        reloads,
        { field: 'config', why: '.env is linked in from your service config folder' },
      ],
      confidence: named ? 'high' : 'medium',
    };
  }

  return {
    spec: {
      name,
      group: 'Services',
      subpath,
      runner: 'command',
      // The built-in server rather than `symfony serve`: it needs nothing but
      // PHP, where the Symfony CLI is a separate install we cannot assume.
      command: ['php', '-S', 'localhost:8000', '-t', 'public'],
      port: 8000,
      ready: { kind: 'tcp', port: 8000 },
      selfReloads: true,
      config: { link: { '.env.local': '${SERVICE_CONFIG_DIR}/.env.local' } },
    },
    evidence: [
      { field: 'runner', why: 'symfony/framework-bundle in composer.json', source: relative('composer.json') },
      { field: 'command', why: "PHP's built-in server on public/ — swap in `symfony serve` if you have the Symfony CLI" },
      { field: 'port', why: 'chosen, not found — nothing in the project names one' },
      reloads,
      { field: 'config', why: '.env.local is linked in from your service config folder' },
    ],
    confidence: 'low',
  };
}

// ── Deno ────────────────────────────────────────────────────────────────────

function detectDeno(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const file = ['deno.json', 'deno.jsonc'].find((f) => repo.exists(f));
  if (!file) return null;
  const config = parseJsonc(repo.read(file) ?? '') as { tasks?: Record<string, unknown> } | null;
  const tasks = config?.tasks ?? {};
  const task = ['dev', 'start'].find((t) => taskCommand(tasks[t]) !== undefined);
  if (!task) return null;

  const relative = (f: string) => (dir ? `${dir}/${f}` : f);
  const body = taskCommand(tasks[task]) as string;
  const flagged = portInScript(body);
  // Deno.serve listens on 8000 unless told otherwise, and so does Fresh.
  const port = flagged ?? 8000;
  // A task that watches is one we must not restart on top of; one that does
  // not is ours to restart.
  const watching = /--watch\b|\bvite\b/.test(body);
  return {
    spec: {
      name,
      group: 'Services',
      subpath: dir || undefined,
      runner: 'command',
      command: ['deno', 'task', task],
      port,
      ready: { kind: 'tcp', port },
      selfReloads: watching,
      watch: watching ? undefined : [relative('**/*.ts'), relative('**/*.tsx')],
      config: {},
    },
    evidence: [
      { field: 'runner', why: `a "${task}" task in ${file}`, source: relative(file) },
      { field: 'command', why: `${file} tasks.${task}`, source: relative(file) },
      flagged
        ? { field: 'port', why: `the port flag in tasks.${task}`, source: relative(file) }
        : { field: 'port', why: 'Deno.serve default — no port found in the task' },
      watching
        ? { field: 'selfReloads', why: 'the task watches and restarts itself — overcli will not restart it on change' }
        : { field: 'selfReloads', why: 'the task does not watch, so overcli restarts it on change' },
    ],
    confidence: 'medium',
  };
}

/// A deno task is either the command string or `{ command, description }`.
function taskCommand(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string') {
    return (value as { command: string }).command;
  }
  return undefined;
}

/// JSON with comments and trailing commas, as deno.jsonc allows. Strings are
/// matched first so the `//` in an import URL is not taken for a comment.
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// ── Rust ────────────────────────────────────────────────────────────────────

interface Crate {
  /// Directory relative to the detected directory; empty for the root crate.
  dir: string;
  package: string;
  bins: string[];
  /// The web framework it depends on, if any — the difference between a
  /// service and a CLI tool, which Cargo.toml otherwise does not record.
  web: string | null;
}

/// A workspace's Cargo.toml is split into one crate per binary a person would
/// run: `cargo run -p api` from the root, not a `cd` into the member, so the
/// shared target directory and lockfile are the ones used.
function detectRust(repo: RepoReader, name: string, dir: string): ServiceProposal[] {
  const manifest = repo.read('Cargo.toml');
  if (manifest === null) return [];
  const workspace = tomlTable(manifest, '[workspace]');

  const crates: Crate[] = [];
  const root = readCrate(repo, '');
  if (root && root.bins.length > 0) crates.push(root);
  for (const member of workspace === null ? [] : cargoMembers(repo, workspace)) {
    const crate = readCrate(repo, member);
    if (crate && crate.bins.length > 0) crates.push(crate);
  }

  const relative = (file: string) => (dir ? `${dir}/${file}` : file);
  const total = crates.reduce((n, c) => n + c.bins.length, 0);
  return crates.flatMap((crate) =>
    crate.bins.map((bin): ServiceProposal => {
      const manifestPath = relative(crate.dir ? `${crate.dir}/Cargo.toml` : 'Cargo.toml');
      const command = [
        'cargo',
        'run',
        ...(crate.dir ? ['-p', crate.package] : []),
        // Without it, a package with several binaries refuses to guess.
        ...(crate.bins.length > 1 ? ['--bin', bin] : []),
      ];
      // Rocket is the one framework with a default port; axum and the rest
      // bind whatever the code says, and guessing would invent a clash.
      const port = crate.web === 'rocket' ? 8000 : undefined;
      return {
        spec: {
          name: total === 1 ? name : bin,
          group: 'Services',
          subpath: dir || undefined,
          runner: 'command',
          command,
          port,
          ready: port === undefined ? { kind: 'none' } : { kind: 'tcp', port },
          selfReloads: false,
          // Every .rs file, not just the crate's own: a change to a sibling
          // library in the workspace is a change to this binary too.
          watch: [relative('**/*.rs')],
          config: {},
        },
        evidence: [
          {
            field: 'runner',
            why: crate.web ? `a binary target that depends on ${crate.web}` : 'a binary target — no web framework, so maybe a CLI',
            source: manifestPath,
          },
          {
            field: 'command',
            why: crate.dir
              ? `the ${crate.package} member of a Cargo workspace, run from the root`
              : crate.bins.length > 1
                ? 'one of several binaries in the package'
                : 'the package binary',
          },
          port === undefined
            ? { field: 'ready', why: 'no port found — nothing to probe until you set one' }
            : { field: 'port', why: 'Rocket defaults to 8000' },
        ],
        confidence: crate.web ? 'medium' : 'low',
      };
    }),
  );
}

const RUST_WEB = /^\s*(axum|actix-web|rocket|warp|poem|salvo|tide|hyper)\s*=/m;

/// The binaries one crate builds: `[[bin]]` tables, `src/main.rs`, and the
/// files under `src/bin/` that Cargo discovers on its own.
function readCrate(repo: RepoReader, dir: string): Crate | null {
  const at = (file: string) => (dir ? `${dir}/${file}` : file);
  const manifest = repo.read(at('Cargo.toml'));
  if (manifest === null) return null;
  const pkg = tomlString(tomlTable(manifest, '[package]') ?? '', 'name');
  if (!pkg) return null;

  const bins: string[] = [];
  let mainClaimed = false;
  for (const table of tomlTables(manifest, '[[bin]]')) {
    const bin = tomlString(table, 'name');
    if (bin) bins.push(bin);
    if (tomlString(table, 'path') === 'src/main.rs') mainClaimed = true;
  }
  if (!mainClaimed && repo.exists(at('src/main.rs')) && !bins.includes(pkg)) bins.push(pkg);
  for (const entry of repo.list?.(at('src/bin')) ?? []) {
    const bin = entry.endsWith('.rs')
      ? entry.slice(0, -3)
      : repo.exists(at(`src/bin/${entry}/main.rs`))
        ? entry
        : null;
    if (bin && !bins.includes(bin)) bins.push(bin);
  }
  return { dir, package: pkg, bins, web: RUST_WEB.exec(manifest)?.[1] ?? null };
}

/// `members = [...]` out of a `[workspace]` table. A trailing `/*` glob is
/// expanded when the reader can list; any other glob is skipped rather than
/// half-matched.
function cargoMembers(repo: RepoReader, workspace: string): string[] {
  const block = /members\s*=\s*\[([\s\S]*?)\]/.exec(workspace);
  if (!block) return [];
  const out: string[] = [];
  for (const quoted of block[1].matchAll(/"([^"]+)"/g)) {
    const member = quoted[1].replace(/\/+$/, '');
    if (member.endsWith('/*')) {
      const parent = member.slice(0, -2);
      for (const entry of repo.list?.(parent) ?? []) {
        if (repo.exists(`${parent}/${entry}/Cargo.toml`)) out.push(`${parent}/${entry}`);
      }
    } else if (!member.includes('*')) {
      out.push(member);
    }
  }
  return [...new Set(out)];
}

/// The bodies of every table with this exact header (`[package]`, `[[bin]]`).
/// A line scan, not a TOML parser: the handful of keys detection needs are
/// always plain `key = "value"` lines.
function tomlTables(text: string, header: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const bare = line.replace(/#.*$/, '').trim();
    if (bare.startsWith('[') && bare.endsWith(']') && !bare.includes('"')) {
      if (current) out.push(current.join('\n'));
      current = bare.replace(/\s+/g, '') === header ? [] : null;
      continue;
    }
    current?.push(line);
  }
  if (current) out.push(current.join('\n'));
  return out;
}

function tomlTable(text: string, header: string): string | null {
  return tomlTables(text, header)[0] ?? null;
}

function tomlString(table: string, key: string): string | null {
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(table)?.[1] ?? null;
}

// ── .NET ────────────────────────────────────────────────────────────────────

/// Projects that run, from the `.csproj` files near the top of the directory.
/// Web projects are services; a worker is a service with no port; a plain
/// console app is only offered when there is nothing better, because most of
/// them in a solution are tools and test harnesses.
function detectDotnet(repo: RepoReader, name: string, dir: string): ServiceProposal[] {
  if (!repo.list) return [];
  const relative = (file: string) => (dir ? `${dir}/${file}` : file);

  const web: string[] = [];
  const workers: string[] = [];
  const consoles: string[] = [];
  for (const project of findProjects(repo, '.csproj')) {
    const text = repo.read(project) ?? '';
    const sdk = /<Project[^>]*\bSdk\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? '';
    if (/Microsoft\.NET\.Test\.Sdk/.test(text)) continue;
    if (/^Microsoft\.NET\.Sdk\.Web$/i.test(sdk)) web.push(project);
    else if (/^Microsoft\.NET\.Sdk\.Worker$/i.test(sdk)) workers.push(project);
    else if (/<OutputType>\s*Exe\s*<\/OutputType>/i.test(text)) consoles.push(project);
  }
  const chosen: [string, 'web' | 'worker' | 'console'][] = [
    ...web.map((p) => [p, 'web'] as [string, 'web']),
    ...workers.map((p) => [p, 'worker'] as [string, 'worker']),
  ];
  if (chosen.length === 0) chosen.push(...consoles.map((p) => [p, 'console'] as [string, 'console']));

  return chosen.map(([project, kind]): ServiceProposal => {
    const slash = project.lastIndexOf('/');
    const projectDir = slash === -1 ? '' : project.slice(0, slash);
    const projectName = project.slice(slash + 1).replace(/\.csproj$/, '');
    const settingsPath = projectDir ? `${projectDir}/Properties/launchSettings.json` : 'Properties/launchSettings.json';
    // `dotnet run` applies the first launch profile, and its applicationUrl is
    // the port the app really opens — the http one, since the probe is plain.
    const found = kind === 'web' ? launchSettingsPort(repo.read(settingsPath)) : null;
    const port = kind === 'web' ? (found ?? 5000) : undefined;
    return {
      spec: {
        name: chosen.length === 1 ? name : projectName,
        group: port === undefined ? 'Processors' : 'Services',
        subpath: dir || undefined,
        runner: 'command',
        command: ['dotnet', 'run', '--project', project],
        port,
        ready: port === undefined ? { kind: 'none' } : { kind: 'tcp', port },
        // `dotnet watch` would hot-reload; `dotnet run` does not, so we restart.
        selfReloads: false,
        watch: [relative(projectDir ? `${projectDir}/**/*.cs` : '**/*.cs')],
        config: {},
      },
      evidence: [
        {
          field: 'runner',
          why:
            kind === 'web'
              ? 'the Microsoft.NET.Sdk.Web SDK'
              : kind === 'worker'
                ? 'the Microsoft.NET.Sdk.Worker SDK'
                : 'an Exe output type — a console app, which may be a tool rather than a service',
          source: relative(project),
        },
        { field: 'command', why: 'dotnet run on the project, from the directory it was found in' },
        port === undefined
          ? { field: 'ready', why: 'no port — nothing to probe' }
          : found
            ? { field: 'port', why: 'applicationUrl in the launch settings', source: relative(settingsPath) }
            : { field: 'port', why: 'no launch settings — Kestrel defaults to 5000' },
      ],
      confidence: kind === 'console' ? 'low' : found ? 'high' : 'medium',
    };
  });
}

/// Project files in the directory, its immediate subdirectories, and those of
/// `src/` — where `dotnet new sln` layouts put them. Not a recursive walk: a
/// checkout's node_modules is not somewhere a project file lives.
function findProjects(repo: RepoReader, extension: string): string[] {
  const list = repo.list!;
  const skip = (entry: string) => entry.startsWith('.') || ['node_modules', 'bin', 'obj'].includes(entry);
  const out: string[] = [];
  const scan = (base: string) => {
    for (const entry of list(base)) {
      if (entry.endsWith(extension)) out.push(base ? `${base}/${entry}` : entry);
    }
  };
  scan('');
  for (const entry of list('')) {
    if (skip(entry) || entry.endsWith(extension)) continue;
    scan(entry);
    if (entry === 'src') for (const inner of list('src')) if (!skip(inner)) scan(`src/${inner}`);
  }
  return [...new Set(out)];
}

function launchSettingsPort(text: string | null): number | null {
  if (!text) return null;
  const urls = [...text.matchAll(/"applicationUrl"\s*:\s*"([^"]+)"/g)].flatMap((m) => m[1].split(';'));
  const url = urls.find((u) => u.startsWith('http://')) ?? urls[0];
  const port = url ? /:(\d{2,5})(?:\/|$)/.exec(url) : null;
  return port ? Number(port[1]) : null;
}

// ── Compose ─────────────────────────────────────────────────────────────────

function detectCompose(repo: RepoReader, name: string, dir: string): ServiceProposal | null {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'].find((f) =>
    repo.exists(f),
  );
  if (!file) return null;
  return {
    spec: {
      name,
      group: 'Infrastructure',
      subpath: dir || undefined,
      runner: 'docker-compose',
      command: ['docker', 'compose', '-f', file, 'up'],
      ready: { kind: 'none' },
      selfReloads: false,
      config: {},
    },
    evidence: [
      { field: 'runner', why: `${file} in the project root`, source: dir ? `${dir}/${file}` : file },
      { field: 'command', why: 'compose brings the file up as one unit' },
    ],
    confidence: 'medium',
  };
}
