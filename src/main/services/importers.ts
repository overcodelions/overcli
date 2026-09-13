// Importing the setup you already have.
//
// Nobody's services start life undescribed. They are in a Tiltfile, a
// docker-compose.yml, a Procfile, a folder of IntelliJ run configurations, or
// a VS Code launch.json — files that already say what runs, with which
// options, on which port. Detection guesses; an import KNOWS, and it carries
// the twenty JVM flags someone spent an afternoon getting right.
//
// The part that makes this more than a file reader is `factorCommon`. Ten
// IntelliJ run configs for one codebase are ninety percent identical — same
// database, same credentials, same heap — and differ in one or two flags each.
// Imported flat, that is ten services with ten copies of the same password.
// Factored, it is one shared set and ten short lists of differences, which is
// exactly the copy model the rest of the engine already has.
//
// Every parser here is pure text in, data out, so the awkward real files can
// be pinned in tests.

import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseOptions } from './options';
import type { ImportSet, ImportSource, ImportedService } from '../../shared/servicesImport';
import type { ServiceOption, ServiceSpec } from './types';

export type { ImportSet, ImportSource, ImportedService };

// ── IntelliJ ────────────────────────────────────────────────────────────────

/// One `.idea/runConfigurations/*.xml` or `.run/*.xml`.
///
/// IntelliJ keeps everything in `<option name value>` pairs, which is easier to
/// read with a regex than to model: the schema varies by configuration type and
/// only a handful of keys matter to us.
export function parseIntellijRunConfig(xml: string, home = ''): ImportedService | null {
  const name = attr(xml, /<configuration\b[^>]*\bname="([^"]*)"/);
  if (!name) return null;

  const vm = option(xml, 'VM_PARAMETERS');
  const programArgs = option(xml, 'PROGRAM_PARAMETERS');
  const workingDir = option(xml, 'WORKING_DIRECTORY');
  const profiles = option(xml, 'ACTIVE_PROFILES');
  const module = attr(xml, /<module\s+name="([^"]*)"/);

  // Path variables appear inside option VALUES too, not just in the working
  // directory — `-Dlocal.webapp.root.dir="$USER_HOME$/gitrepo/…"` is a real
  // line from a real config, and passed through unexpanded it is a path that
  // does not exist.
  const options = parseOptions(decodeXml(vm ?? '')).map((o) =>
    o.value === undefined ? o : { ...o, value: expandIntellij(o.value, home) },
  );
  if (profiles && !options.some((o) => o.key === '-Dspring.profiles.active')) {
    // IntelliJ stores the Spring profile in its own field rather than as a
    // flag; the process needs it as one.
    options.push({ key: '-Dspring.profiles.active', value: profiles });
  }
  for (const arg of parseOptions(decodeXml(programArgs ?? ''))) options.push(arg);

  const buildTask = intellijBuildTask(xml);
  if (buildTask) {
    return {
      name,
      command: buildTask,
      // The app's JVM flags mean nothing to a publish, and a module hint would
      // pool this with the app's own configs and share their options into it.
      options: [],
      env: parseIntellijEnv(xml),
      group: attr(xml, /<configuration\b[^>]*\bfolderName="([^"]*)"/) ?? undefined,
      task: true,
      source: 'intellij',
    };
  }

  return {
    name,
    options,
    env: parseIntellijEnv(xml),
    // `$USER_HOME$/gitrepo/AcmeProcessor` — the last segment is the module
    // directory, which is what a subpath means here.
    subpath: workingDir ? lastSegment(expandIntellij(workingDir, home)) : undefined,
    // IntelliJ names a main class, not a command: the caller pairs this with
    // the detected Gradle or Maven module of the same name.
    moduleHint: module?.replace(/_main$/, '') ?? undefined,
    group: attr(xml, /<configuration\b[^>]*\bfolderName="([^"]*)"/) ?? undefined,
    source: 'intellij',
  };
}

/// Run configurations kept in `.idea/workspace.xml` — IntelliJ's default when
/// nobody ticked "Store as project file". Same `<configuration>` elements as a
/// shared file, several to a `RunManager` component. Templates (`default`) and
/// the throwaway ones IntelliJ makes when you run a main class (`temporary`)
/// are not anything someone chose to keep.
export function parseIntellijWorkspace(xml: string, home = ''): ImportedService[] {
  const manager = /<component\s+name="RunManager"[^>]*>([\s\S]*?)<\/component>/.exec(xml);
  if (!manager) return [];
  const out: ImportedService[] = [];
  for (const match of manager[1].matchAll(/<configuration\b[^>]*?(?:\/>|>[\s\S]*?<\/configuration>)/g)) {
    const block = match[0];
    const open = block.slice(0, block.indexOf('>') + 1);
    if (/\bdefault="true"/.test(open) || /\btemporary="true"/.test(open)) continue;
    const parsed = parseIntellijRunConfig(block, home);
    if (parsed) out.push(parsed);
  }
  return out;
}

/// The command of a Gradle or Maven run configuration that runs something
/// other than the app — `publishToMavenLocal`, `clean install`. One that boots
/// the app is not a task, and stays paired with detection as before.
function intellijBuildTask(xml: string): string[] | null {
  const type = attr(xml, /<configuration\b[^>]*\btype="([^"]*)"/);
  const listed = (name: string) => {
    const block = new RegExp(`<option\\s+name="${name}">\\s*<list>([\\s\\S]*?)</list>`).exec(xml);
    return block ? [...block[1].matchAll(/<option\s+value="([^"]*)"/g)].map((m) => decodeXml(m[1])) : [];
  };

  if (type === 'GradleRunConfiguration') {
    const tasks = listed('taskNames');
    if (tasks.length === 0 || tasks.some((t) => /(^|:)(bootRun|run)$/.test(t))) return null;
    const script = decodeXml(option(xml, 'scriptParameters') ?? '').split(/\s+/).filter(Boolean);
    return ['./gradlew', ...tasks, ...script, '-Dorg.gradle.daemon=false'];
  }
  if (type === 'MavenRunConfiguration') {
    const goals = listed('goals');
    if (goals.length === 0 || goals.some((g) => /spring-boot:run|exec:java/.test(g))) return null;
    return ['mvn', ...goals];
  }
  return null;
}

function parseIntellijEnv(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const block = /<envs>([\s\S]*?)<\/envs>/.exec(xml);
  if (!block) return out;
  for (const match of block[1].matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"/g)) {
    out[match[1]] = decodeXml(match[2]);
  }
  return out;
}

/// `$USER_HOME$`, `$PROJECT_DIR$` and `file://` — the three IntelliJ path
/// spellings that would otherwise be passed through as literal nonsense.
export function expandIntellij(value: string, home: string): string {
  return value
    .replace(/^file:\/\//, '')
    .replace(/\$USER_HOME\$/g, home)
    .replace(/\$PROJECT_DIR\$/g, '.')
    .replace(/\$MODULE_DIR\$/g, '.');
}

// ── VS Code ─────────────────────────────────────────────────────────────────

/// `.vscode/launch.json`. JSONC in practice — comments and trailing commas are
/// both common and both fatal to `JSON.parse`, so they are stripped first.
export function parseVsCodeLaunch(text: string): ImportedService[] {
  let parsed: { configurations?: unknown[] };
  try {
    parsed = JSON.parse(stripJsonc(text)) as { configurations?: unknown[] };
  } catch {
    return [];
  }
  const out: ImportedService[] = [];

  for (const raw of parsed.configurations ?? []) {
    const config = raw as Record<string, unknown>;
    const name = typeof config.name === 'string' ? config.name : null;
    if (!name) continue;
    // An attach configuration runs nothing — it connects to something already
    // running, which is the opposite of what we are importing.
    if (config.request === 'attach') continue;

    const options: ServiceOption[] = [];
    for (const flag of asStrings(config.vmArgs)) options.push(...parseOptions(flag));
    for (const arg of asStrings(config.args)) options.push(...parseOptions(arg));

    const env: Record<string, string> = {};
    if (config.env && typeof config.env === 'object') {
      for (const [k, v] of Object.entries(config.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    out.push({
      name,
      command: vsCodeCommand(config),
      options,
      env,
      subpath: typeof config.cwd === 'string' ? stripWorkspaceFolder(config.cwd) : undefined,
      moduleHint: typeof config.projectName === 'string' ? config.projectName : undefined,
      source: 'vscode',
    });
  }
  return out;
}

/// `.vscode/tasks.json` — the build steps someone already runs by hand from
/// the editor. They run once, so each comes in as a task, with `dependsOn`
/// kept. A background task is a watcher that never exits, and a provider
/// task (`"type": "npm"`) states no command, so neither comes in.
export function parseVsCodeTasks(text: string): ImportedService[] {
  let parsed: { tasks?: unknown[] };
  try {
    parsed = JSON.parse(stripJsonc(text)) as { tasks?: unknown[] };
  } catch {
    return [];
  }
  const out: ImportedService[] = [];

  for (const raw of parsed.tasks ?? []) {
    const task = raw as Record<string, unknown>;
    const name = typeof task.label === 'string' ? task.label : null;
    if (!name || task.isBackground === true) continue;
    if (task.type !== 'shell' && task.type !== 'process') continue;
    if (typeof task.command !== 'string' || !task.command.trim()) continue;

    const args = asStrings(task.args);
    const line = [task.command, ...args].join(' ');
    // A shell task is handed to the shell, as VS Code does; a process task
    // is argv already.
    const command =
      task.type === 'process'
        ? [task.command, ...args]
        : /[&|;<>$`]|^\s*cd\s/.test(line)
          ? ['sh', '-c', line]
          : line.split(/\s+/).filter(Boolean);
    const cwd = (task.options as Record<string, unknown> | undefined)?.cwd;

    out.push({
      name,
      command,
      options: [],
      env: {},
      subpath: typeof cwd === 'string' ? stripWorkspaceFolder(cwd) || undefined : undefined,
      task: true,
      deps: asStrings(task.dependsOn).length > 0 ? asStrings(task.dependsOn) : undefined,
      source: 'vscode-tasks',
    });
  }
  return out;
}

/// What VS Code would run, for the launch types that state it plainly. Java
/// configs name a main class instead, and are paired with a detected module by
/// the caller, same as IntelliJ.
function vsCodeCommand(config: Record<string, unknown>): string[] | undefined {
  if (config.type === 'node' || config.type === 'pwa-node') {
    if (typeof config.runtimeExecutable === 'string') {
      return [config.runtimeExecutable, ...asStrings(config.runtimeArgs)];
    }
    if (typeof config.program === 'string') return ['node', stripWorkspaceFolder(config.program)];
  }
  if (config.type === 'python' || config.type === 'debugpy') {
    if (config.module) return ['python', '-m', String(config.module)];
    if (typeof config.program === 'string') {
      return ['python', stripWorkspaceFolder(config.program)];
    }
  }
  if (config.type === 'go' && typeof config.program === 'string') {
    return ['go', 'run', stripWorkspaceFolder(config.program)];
  }
  return undefined;
}

function stripWorkspaceFolder(value: string): string {
  return value.replace(/\$\{workspaceFolder\}\/?/g, '').replace(/^\.\//, '');
}

/// Strip `//` and `/* */` comments and trailing commas — launch.json is JSONC
/// and VS Code's own template ships with comments in it.
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') (inLine = false), (out += ch);
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') (inBlock = false), i++;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') (out += next ?? ''), i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') (inString = true), (out += ch);
    else if (ch === '/' && next === '/') (inLine = true), i++;
    else if (ch === '/' && next === '*') (inBlock = true), i++;
    else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// ── docker compose ──────────────────────────────────────────────────────────

export function parseCompose(text: string, file: string): ImportSet | null {
  let doc: { services?: Record<string, unknown> };
  try {
    doc = parseYaml(text) as { services?: Record<string, unknown> };
  } catch {
    return null;
  }
  if (!doc?.services) return null;

  const services: ImportedService[] = [];
  for (const [name, raw] of Object.entries(doc.services)) {
    const service = (raw ?? {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    // Both spellings are legal and both are common.
    if (Array.isArray(service.environment)) {
      for (const entry of service.environment) {
        const [k, ...rest] = String(entry).split('=');
        if (k) env[k] = rest.join('=');
      }
    } else if (service.environment && typeof service.environment === 'object') {
      for (const [k, v] of Object.entries(service.environment as Record<string, unknown>)) {
        env[k] = v === null || v === undefined ? '' : String(v);
      }
    }

    services.push({
      name,
      command: ['docker', 'compose', '-f', file, 'up', name],
      options: [],
      env,
      port: composePort(service.ports),
      group: 'Infrastructure',
      moduleHint: name,
      source: 'compose',
    });
  }
  return { source: 'compose', file, services: services };
}

/// The host side of the first published port — `"8080:80"`, `8080`, or the
/// long form. The container side is not ours to care about.
function composePort(ports: unknown): number | undefined {
  if (!Array.isArray(ports) || ports.length === 0) return undefined;
  const first = ports[0];
  if (typeof first === 'number') return first;
  if (typeof first === 'string') {
    const host = first.split(':')[first.split(':').length > 2 ? 1 : 0];
    const parsed = Number.parseInt(host, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (first && typeof first === 'object' && 'published' in first) {
    const published = Number((first as { published: unknown }).published);
    return Number.isNaN(published) ? undefined : published;
  }
  return undefined;
}

// ── Procfile ────────────────────────────────────────────────────────────────

export function parseProcfile(text: string): ImportedService[] {
  const out: ImportedService[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    // Procfile commands are shell lines. Splitting on whitespace is right for
    // the common `npm run dev` and wrong for anything with a pipe — which is
    // rare enough to be worth the simplicity, and visible before it is added.
    out.push({
      name: match[1],
      command: match[2].split(/\s+/),
      options: [],
      env: {},
      source: 'procfile',
    });
  }
  return out;
}

// ── Tiltfile ────────────────────────────────────────────────────────────────

/// Services out of a Tiltfile.
///
/// A Tiltfile is a Starlark PROGRAM, and a real one rarely calls
/// `local_resource` directly for its services — it defines `microservice()`
/// or `mono_app()` once and calls that thirty times. Reading only the direct
/// calls found the one-off tasks and missed every service that mattered, and
/// scraped a link out of a helper's body as if it were a name.
///
/// So this follows helpers ONE level: a `def` whose body calls
/// `local_resource` with one of its own parameters as the name is a template,
/// and every call to it is a service — its name, port, group and Gradle module
/// read from the arguments, bound to the parameters the way Starlark would.
/// It also reads the JVM args script a helper points at, because that is where
/// the fifty-seven options live.
///
/// A command is read wherever it is only strings joined with `+`: literals,
/// parameters, globals, the helper's own straight-line locals, and one-line
/// `return` helpers like `_flag(name)`. Anything more — a conditional, a
/// loop, a local set inside an `if` — leaves it unknown. A helper's command is
/// a fallback: detection still wins where it finds one, since it knows the
/// module the options belong to.
///
/// A `local_resource` with only `cmd=` runs once and exits — a publish to
/// Maven local, an image build — and comes in as a task, with its
/// `resource_deps` kept so what needs it still waits for it.
export function parseTiltfile(
  text: string,
  readFile?: (relative: string) => string | null,
  context?: TiltfileContext,
): ImportedService[] {
  const source = stripStarlarkComments(text);
  const defs = findDefs(source);
  const globals = findGlobals(source);
  const starlark = starlarkEvaluator(defs, globals, context);
  const insideDef = (index: number) => defs.some((d) => index >= d.start && index < d.end);
  const found: { index: number; service: ImportedService }[] = [];

  for (const call of findCalls(source, 'local_resource')) {
    if (insideDef(call.index)) continue;
    const nameArg = call.args.find((a) => !a.key) ?? call.args.find((a) => a.key === 'name');
    const name = stringLiteral(nameArg?.value);
    const serve = call.args.find((a) => a.key === 'serve_cmd');
    const once = call.args.find((a) => a.key === 'cmd');
    const run = serve ?? once;
    if (!name || !run) continue;
    const task = !serve;
    found.push({
      index: call.index,
      service: {
        name,
        command: commandValue(starlark.evaluate(run.value, starlark.global)),
        options: [],
        env: {},
        group: labelGroup(call.args.find((a) => a.key === 'labels')?.value),
        port: localhostPort([call.args.find((a) => a.key === 'links')?.value]),
        // Tilt runs `cmd` in `dir` and `serve_cmd` in `serve_dir`.
        repoHint: lastPathSegment(
          call.args.find((a) => a.key === (task ? 'dir' : 'serve_dir'))?.value,
          (id) => globals[id],
        ),
        task: task || undefined,
        deps: listLiteral(call.args.find((a) => a.key === 'resource_deps')?.value),
        excerpt: excerpt(source.slice(call.index, call.end)),
        source: 'tiltfile',
      },
    });
  }

  for (const def of defs) {
    if (!def.template) continue;
    for (const call of findCalls(source, def.name)) {
      if (insideDef(call.index)) continue;
      const bound = bindArgs(def.params, call.args);
      const name = stringLiteral(bound[def.template.nameParam]);
      if (!name) continue;

      const port = intLiteral(bound.port);
      const explicitDebugPort = intLiteral(bound.debug_port);
      const debugOffset = /\bdebug_port\s*=\s*port\s*\+\s*(\d+)/.exec(def.body);
      const debugPort = explicitDebugPort && explicitDebugPort > 0
        ? explicitDebugPort
        : port && port > 0 && debugOffset
          ? port + Number(debugOffset[1])
          : undefined;
      const options: ImportedService['options'] = [];
      for (const param of def.params) {
        const value = stringLiteral(bound[param.name]);
        if (!value?.endsWith('.sh') || !readFile) continue;
        for (const candidate of scriptCandidates(def.body, param.name, value)) {
          let script: string | null = null;
          try {
            script = readFile(candidate);
          } catch {
            script = null;
          }
          if (!script) continue;
          options.push(...parseArgsScript(script));
          break;
        }
      }

      // The repo it runs in: the helper's own `repo` parameter when it has
      // one, else whatever its resource's serve_dir comes to.
      const lookup = (id: string) => bound[id] ?? globals[id];
      const repoArg = bound.repo ?? bound.repo_path ?? bound.repo_dir;
      const subdir = stringLiteral(bound.subdir);
      const { serveCmd, resourceAt } = def.template;
      const helperCommand =
        serveCmd === undefined
          ? undefined
          : commandValue(
              starlark.evaluate(serveCmd, starlark.bodyScope(def, call.args, starlark.global, resourceAt)),
            );

      found.push({
        index: call.index,
        service: {
          name,
          helperCommand,
          options,
          env: {},
          port: port !== undefined && port > 0 ? port : localhostPort(Object.values(bound)),
          debugPort,
          group: labelGroup(bound.group ?? bound.label) ?? labelGroup(def.template.labels),
          moduleHint: stringLiteral(bound.gradle_module ?? bound.module),
          repoHint: lastPathSegment(repoArg ?? def.template.serveDir, lookup),
          subpath: subdir || undefined,
          nodeVersion: stringLiteral(bound.node_version),
          // `resource_deps=resource_deps` hands the caller's list through;
          // a literal in the helper applies to every call.
          deps: listLiteral(
            def.template.resourceDeps && /^[A-Za-z_]\w*$/.test(def.template.resourceDeps)
              ? bound[def.template.resourceDeps]
              : def.template.resourceDeps,
          ),
          // The call and the helper it goes through: the real start line is
          // usually split between the two.
          excerpt: excerpt(
            `${source.slice(call.index, call.end)}\n\n${source.slice(def.start, def.end)}`,
          ),
          source: 'tiltfile',
        },
      });
    }
  }

  // In the order the file declares them, and each name once.
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.service)
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/// How long a quoted piece of a config file may be. Enough for a helper and
/// the call to it; not a whole Tiltfile riding along in every prompt.
const EXCERPT_LIMIT = 4_000;

/// Source text trimmed for keeping: blanked-out comment runs and blank lines
/// collapsed, and capped.
function excerpt(text: string): string {
  const tidy = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy.length > EXCERPT_LIMIT ? `${tidy.slice(0, EXCERPT_LIMIT)}\n…` : tidy;
}

/// A command run under a particular Node through nvm. nvm is a shell function,
/// not a binary, so this is the one place an import produces `sh -c`. A version
/// that is not a plain version string is not pasted into a shell line.
export function withNodeVersion(command: readonly string[], version: string): string[] {
  if (!/^v?\d+(\.\d+)*$/.test(version)) return [...command];
  const line = command
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(' ');
  return ['sh', '-c', `. "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use ${version} && exec ${line}`];
}

/// The flags a JVM-args script echoes. The shape Tilt setups converge on: one
/// `echo` of `-D` lines joined with backslashes, with `${VAR}` left for the
/// shell — and kept verbatim here, because `${NAME}` is exactly what machine
/// values fill in.
export function parseArgsScript(text: string): ImportedService['options'] {
  const echo = /\becho\s+(["'])([\s\S]*?)\1/.exec(text);
  if (!echo) return [];
  return parseOptions(echo[2].replace(/\\\r?\n/g, ' ').replace(/\\\s*$/gm, ' '));
}

interface StarlarkArg {
  key?: string;
  value: string;
}

interface StarlarkDef {
  name: string;
  params: { name: string; default?: string }[];
  body: string;
  start: number;
  end: number;
  /// The expression of a body that is nothing but `return <expression>`.
  returns?: string;
  /// Set when the body declares a resource named by one of the parameters,
  /// with the `labels`, `serve_dir` and `serve_cmd` that resource was given.
  template?: {
    nameParam: string;
    labels?: string;
    serveDir?: string;
    serveCmd?: string;
    resourceDeps?: string;
    /// Where in the body the resource is declared; locals after it are not
    /// part of its command.
    resourceAt: number;
  };
}

/// Where a Tiltfile's `os.getenv` and `os.path.abspath` look: the folder it
/// sits in and the environment Tilt would run it under.
export interface TiltfileContext {
  dir: string;
  env: Record<string, string | undefined>;
}

type StarlarkValue = string | string[] | undefined;
type StarlarkLookup = (id: string) => StarlarkValue;

/// How deep an expression may nest calls and names before it is unknown.
const EVAL_DEPTH_LIMIT = 16;

/// Just enough Starlark to read a command built from strings: literals, `+`,
/// names, lists, `str()`, `os.getenv`, `os.path.abspath`, and calls to helpers
/// whose whole body is one `return`. Everything else is unknown — never a
/// guess.
function starlarkEvaluator(
  defs: StarlarkDef[],
  globals: Record<string, string>,
  context: TiltfileContext | undefined,
) {
  const cache = new Map<string, StarlarkValue>();
  const resolving = new Set<string>();

  const global: StarlarkLookup = (id) => {
    if (cache.has(id)) return cache.get(id);
    const expression = globals[id];
    if (expression === undefined || resolving.has(id)) return undefined;
    resolving.add(id);
    const value = evaluate(expression, global, 0);
    resolving.delete(id);
    cache.set(id, value);
    return value;
  };

  function evaluate(expression: string, lookup: StarlarkLookup, depth = 0): StarlarkValue {
    if (depth > EVAL_DEPTH_LIMIT) return undefined;
    const terms = splitTopLevel(expression, '+').map((t) => t.trim());
    if (terms.length === 1) return term(terms[0], lookup, depth);
    let out = '';
    for (const piece of terms) {
      const value = term(piece, lookup, depth);
      if (typeof value !== 'string') return undefined;
      out += value;
    }
    return out;
  }

  function term(text: string, lookup: StarlarkLookup, depth: number): StarlarkValue {
    if (text === '') return undefined;
    const literal = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(text);
    if (literal) return unescapeStarlark(literal[2]);
    if (/^\d+$/.test(text)) return text;
    if (/^[A-Za-z_]\w*$/.test(text)) return lookup(text);
    if (text[0] === '(' && bracketed(text, 0)?.end === text.length) {
      return evaluate(text.slice(1, -1), lookup, depth + 1);
    }
    if (text[0] === '[' && bracketed(text, 0)?.end === text.length) {
      const items = splitArgs(text.slice(1, -1)).map((a) =>
        a.key ? undefined : evaluate(a.value, lookup, depth + 1),
      );
      return items.every((i): i is string => typeof i === 'string') ? items : undefined;
    }
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(text);
    const inner = call ? bracketed(text, call[0].length - 1) : null;
    if (!call || !inner || inner.end !== text.length) return undefined;
    const args = splitArgs(inner.inner);
    const arg = (i: number) =>
      args[i] && !args[i].key ? evaluate(args[i].value, lookup, depth + 1) : undefined;

    switch (call[1]) {
      case 'str':
        return typeof arg(0) === 'string' ? arg(0) : undefined;
      case 'os.getenv': {
        const name = arg(0);
        if (!context || typeof name !== 'string') return undefined;
        return context.env[name] ?? arg(1);
      }
      case 'os.path.abspath': {
        const value = arg(0);
        return context && typeof value === 'string' ? path.resolve(context.dir, value) : undefined;
      }
    }
    const def = defs.find((d) => d.name === call[1]);
    if (!def?.returns) return undefined;
    return evaluate(def.returns, paramScope(def, args, lookup, depth), depth + 1);
  }

  /// A helper's parameters: what the call passed, evaluated where it was
  /// called, else the default. A parameter nobody set is unknown, not the
  /// global of the same name.
  function paramScope(
    def: StarlarkDef,
    args: StarlarkArg[],
    caller: StarlarkLookup,
    depth: number,
  ): StarlarkLookup {
    const values = new Map<string, () => StarlarkValue>();
    for (const p of def.params) {
      const fallback = p.default;
      values.set(p.name, () => (fallback === undefined ? undefined : evaluate(fallback, global, depth + 1)));
    }
    let position = 0;
    for (const a of args) {
      const name = a.key ?? def.params[position++]?.name;
      if (name) values.set(name, () => evaluate(a.value, caller, depth + 1));
    }
    return (id) => (values.has(id) ? values.get(id)!() : global(id));
  }

  /// Parameters plus the locals a helper assigns before `until`, in order —
  /// `ready += (...)` included. One set inside an `if` or a loop may or may
  /// not have happened, so it is unknown from there on.
  function bodyScope(
    def: StarlarkDef,
    args: StarlarkArg[],
    caller: StarlarkLookup,
    until: number,
  ): StarlarkLookup {
    const params = paramScope(def, args, caller, 0);
    const locals = new Map<string, StarlarkValue>();
    const lookup: StarlarkLookup = (id) => (locals.has(id) ? locals.get(id) : params(id));
    for (const assignment of bodyAssignments(def.body, until)) {
      if (assignment.nested) {
        locals.set(assignment.name, undefined);
        continue;
      }
      const value = evaluate(assignment.expression, lookup, 1);
      if (assignment.op === '=') {
        locals.set(assignment.name, value);
      } else {
        const prior = lookup(assignment.name);
        locals.set(
          assignment.name,
          typeof prior === 'string' && typeof value === 'string' ? prior + value : undefined,
        );
      }
    }
    return lookup;
  }

  return { global, evaluate, bodyScope };
}

/// `name = expr` and `name += expr` statements in a def body before `until`,
/// each marked when it sits deeper than the body's own indentation.
function bodyAssignments(
  body: string,
  until: number,
): { name: string; op: '=' | '+='; expression: string; nested: boolean }[] {
  const out: { name: string; op: '=' | '+='; expression: string; nested: boolean }[] = [];
  let base: number | undefined;
  let i = 0;
  while (i < until && i < body.length) {
    const newline = body.indexOf('\n', i);
    const line = body.slice(i, newline === -1 ? body.length : newline);
    const trimmed = line.trimStart();
    if (trimmed === '') {
      i = newline === -1 ? body.length : newline + 1;
      continue;
    }
    const indent = line.length - trimmed.length;
    base ??= indent;
    const assignment = /^([A-Za-z_]\w*)\s*(\+?=)(?!=)\s*/.exec(trimmed);
    const start = assignment ? i + indent + assignment[0].length : i;
    const end = statementEnd(body, start);
    if (assignment) {
      out.push({
        name: assignment[1],
        op: assignment[2] as '=' | '+=',
        expression: body.slice(start, end),
        nested: indent > base,
      });
    }
    i = end + 1;
  }
  return out;
}

/// The newline a statement starting at `start` ends on — the first one outside
/// strings and brackets, so a call spread over lines is one statement.
function statementEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) return i;
    i++;
  }
  return text.length;
}

function unescapeStarlark(text: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '\n': '' };
  return text.replace(/\\([\s\S])/g, (whole, c: string) => escapes[c] ?? whole);
}

/// Where a string literal starting at `i` ends.
function skipString(text: string, i: number): number {
  const quote = text[i];
  const triple = quote.repeat(3);
  if (text.startsWith(triple, i)) {
    const end = text.indexOf(triple, i + 3);
    return end === -1 ? text.length : end + 3;
  }
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== '\n') {
    if (text[j] === '\\') j++;
    j++;
  }
  return j + 1;
}

/// Comments blanked to spaces, so offsets still line up and a commented-out
/// resource is not a resource.
function stripStarlarkComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '#') {
      const newline = text.indexOf('\n', i);
      const stop = newline === -1 ? text.length : newline;
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/// What sits between a call's brackets; `open` indexes the opening one.
function bracketed(text: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/// `inner` split on `separator` wherever it is outside strings and brackets.
function splitTopLevel(inner: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '"' || c === "'") {
      i = skipString(inner, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === separator && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(inner.slice(start));
  return parts;
}

function splitArgs(inner: string): StarlarkArg[] {
  return splitTopLevel(inner, ',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((part) => {
      const keyword = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
      return keyword ? { key: keyword[1], value: keyword[2].trim() } : { value: part };
    });
}

/// Every call to `fn` — not its `def`, and not a method of the same name.
function findCalls(text: string, fn: string): { index: number; end: number; args: StarlarkArg[] }[] {
  const out: { index: number; end: number; args: StarlarkArg[] }[] = [];
  for (const match of text.matchAll(new RegExp(`(^|[^\\w.])${fn}\\s*\\(`, 'g'))) {
    const index = match.index! + match[1].length;
    if (/\bdef\s+$/.test(text.slice(Math.max(0, index - 8), index))) continue;
    const body = bracketed(text, match.index! + match[0].length - 1);
    if (body) out.push({ index, end: body.end, args: splitArgs(body.inner) });
  }
  return out;
}

function findDefs(text: string): StarlarkDef[] {
  const out: StarlarkDef[] = [];
  for (const match of text.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(/gm)) {
    const signature = bracketed(text, match.index! + match[0].length - 1);
    if (!signature) continue;
    const lineEnd = text.indexOf('\n', signature.end);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    // A body runs until the next line that starts at column zero.
    const next = /^\S/m.exec(text.slice(bodyStart));
    const end = next ? bodyStart + next.index : text.length;
    const body = text.slice(bodyStart, end);
    const params = splitArgs(signature.inner).map((a) =>
      a.key ? { name: a.key, default: a.value } : { name: a.value.replace(/^\*+/, '') },
    );

    const resource = findCalls(body, 'local_resource').find((call) =>
      call.args.some((a) => a.key === 'serve_cmd'),
    );
    const nameArg = resource?.args.find((a) => !a.key) ?? resource?.args.find((a) => a.key === 'name');
    const nameParam = params.find((p) => p.name === nameArg?.value)?.name;
    const statements = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const returns = statements.length === 1 ? /^return\s+(.+)$/.exec(statements[0])?.[1] : undefined;

    out.push({
      name: match[1],
      params,
      body,
      start: match.index!,
      end,
      returns,
      template: nameParam && resource
        ? {
            nameParam,
            labels: resource.args.find((a) => a.key === 'labels')?.value,
            serveDir: resource.args.find((a) => a.key === 'serve_dir')?.value,
            serveCmd: resource.args.find((a) => a.key === 'serve_cmd')?.value,
            resourceDeps: resource.args.find((a) => a.key === 'resource_deps')?.value.trim(),
            resourceAt: resource.index,
          }
        : undefined,
    });
  }
  return out;
}

/// Top-level `NAME = expression` assignments, by name — how
/// `serve_dir=LEGACY_PORTAL_REPO` comes to mean `SERVICES_DIR + '/legacy-portal'`. The
/// first assignment wins; one spanning several lines is not read.
function findGlobals(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of text.matchAll(/^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/gm)) {
    out[match[1]] ??= match[2].trim();
  }
  return out;
}

/// The folder a path expression ends in, for the simple shapes a Tiltfile
/// builds paths from: `'x/y'`, `SERVICES_DIR + '/y'`, `SERVICES_DIR + '/' +
/// repo`, or a name bound to one of those. Anything else is unknown.
function lastPathSegment(
  value: string | undefined,
  lookup: (id: string) => string | undefined,
  depth = 0,
): string | undefined {
  if (value === undefined || depth > 4) return undefined;
  const pieces = splitTopLevel(value, '+');
  const last = pieces[pieces.length - 1].trim();
  const literal = stringLiteral(last);
  if (literal !== undefined) return literal.split('/').filter(Boolean).pop();
  if (/^[A-Za-z_]\w*$/.test(last)) return lastPathSegment(lookup(last), lookup, depth + 1);
  return undefined;
}

/// Arguments bound to parameters the way Starlark binds them: defaults, then
/// positionals in order, then keywords by name.
function bindArgs(
  params: StarlarkDef['params'],
  args: StarlarkArg[],
): Record<string, string | undefined> {
  const bound: Record<string, string | undefined> = {};
  for (const p of params) bound[p.name] = p.default;
  let position = 0;
  for (const arg of args) {
    if (arg.key) bound[arg.key] = arg.value;
    else if (params[position]) bound[params[position++].name] = arg.value;
  }
  return bound;
}

/// Where a helper looks for a script it was handed: the folder its body joins
/// onto that parameter (`LOCAL_DEV_DIR + '/mono-args/' + args_script`), then
/// beside the Tiltfile.
function scriptCandidates(body: string, param: string, value: string): string[] {
  const out: string[] = [];
  const joined = new RegExp(`['"]/?((?:[\\w.-]+/)*[\\w.-]+)/['"]\\s*\\+\\s*${param}\\b`, 'g');
  for (const match of body.matchAll(joined)) out.push(`${match[1]}/${value}`);
  out.push(value);
  return out;
}

function stringLiteral(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(value.trim());
  return match ? match[2] : undefined;
}

function intLiteral(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/// An evaluated `serve_cmd` or `cmd` as argv: `'npm run dev'` or
/// `['sh', '-c', '...']`.
///
/// Tilt hands a string command to `sh -c`, so one that uses the shell —
/// `cd ../common && ./gradlew publishToMavenLocal` — goes to one here too.
/// Split on spaces it would run a program called `cd`.
function commandValue(value: StarlarkValue): string[] | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value : undefined;
  if (value === undefined) return undefined;
  if (/[&|;<>$`]|^\s*cd\s/.test(value)) return ['sh', '-c', value];
  const argv = value.split(/\s+/).filter(Boolean);
  return argv.length > 0 ? argv : undefined;
}

/// `['a', 'b']` as its strings. Anything built rather than written — a
/// variable, a concatenation — is unknown, not empty.
function listLiteral(value: string | undefined): string[] | undefined {
  const list = value === undefined ? null : /^\[([\s\S]*)\]$/.exec(value.trim());
  if (!list) return undefined;
  const items = splitArgs(list[1])
    .map((a) => stringLiteral(a.value))
    .filter((s): s is string => s !== undefined);
  return items.length > 0 ? items : undefined;
}

/// Tilt labels are commonly sort-prefixed (`1-rest`, `3-procs`); the prefix is
/// ordering, not meaning.
function labelGroup(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const direct = stringLiteral(value);
  const first = direct ?? stringLiteral(/^\[\s*([^,\]]+)/.exec(value.trim())?.[1]);
  return first ? first.replace(/^\d+-/, '') : undefined;
}

/// A port named by a `http://localhost:NNNN` link, for helpers that take a
/// link rather than a port.
function localhostPort(values: (string | undefined)[]): number | undefined {
  for (const value of values) {
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(value ?? '');
    if (match) return Number(match[1]);
  }
  return undefined;
}

// ── factoring ───────────────────────────────────────────────────────────────

export interface FactoredImport {
  /// Options every imported service shares. Becomes the base's option set.
  shared: ServiceOption[];
  /// Per service, only what differs from the shared set.
  perService: { service: ImportedService; own: ServiceOption[] }[];
}

/// Factor each MODULE's configurations separately.
///
/// Eleven run configurations for one codebase are usually four applications
/// with two or three configurations each — four AcmeRest variants, three
/// processors, one billing-rest. Factoring all eleven together finds almost
/// nothing in common, because billing-rest and the processor genuinely disagree
/// about everything; factoring per module finds the sixty flags each set of
/// variants shares, which is the number that matters.
export function factorByModule(
  services: readonly ImportedService[],
): { module: string; factored: FactoredImport }[] {
  const byModule = new Map<string, ImportedService[]>();
  for (const service of services) {
    // A configuration with no module stands alone rather than being pooled
    // with every other orphan, which would invent a shared set out of
    // unrelated apps.
    const key = service.moduleHint ?? `\u0000${service.name}`;
    const list = byModule.get(key) ?? [];
    list.push(service);
    byModule.set(key, list);
  }
  return [...byModule.entries()].map(([key, group]) => ({
    module: key.startsWith('\u0000') ? group[0].name : key,
    factored: factorCommon(group),
  }));
}

/// Split a set of imported services into what they all agree on and what makes
/// each one different.
///
/// This is the whole reason importing beats copy-pasting. Ten IntelliJ configs
/// for one codebase carry the same database credentials, the same heap and the
/// same thirty flags; the difference between them is `-Dproc.type`. Imported
/// flat that is ten services to keep in step by hand. Factored, changing the
/// database password is one edit.
export function factorCommon(services: readonly ImportedService[]): FactoredImport {
  if (services.length < 2) {
    return {
      shared: [],
      perService: services.map((service) => ({ service, own: service.options })),
    };
  }

  const first = services[0].options;
  const shared: ServiceOption[] = [];
  for (const option of first) {
    const everywhere = services.every((s) =>
      s.options.some((o) => o.key === option.key && o.value === option.value),
    );
    // Only identical key AND value is shared. A key everyone sets to a
    // different value is precisely the interesting difference.
    if (everywhere && !shared.some((o) => o.key === option.key)) shared.push(option);
  }

  const sharedKeys = new Map(shared.map((o) => [o.key, o.value]));
  const perService = services.map((service) => ({
    service,
    own: service.options.filter((o) => !(sharedKeys.has(o.key) && sharedKeys.get(o.key) === o.value)),
  }));

  return { shared, perService };
}

/// Values worth lifting out of the imported options into the machine values,
/// where they live once instead of in every service.
///
/// Two rules, both conservative. A value that looks like a credential should
/// not sit in forty option lists; a value that is IDENTICAL across every
/// imported service and looks machine-specific (a path under home, a personal
/// queue prefix) is the same story with a different cause.
export function suggestMachineValues(
  shared: readonly ServiceOption[],
): { name: string; value: string; key: string }[] {
  const out: { name: string; value: string; key: string }[] = [];
  const used = new Set<string>();

  for (const option of shared) {
    if (!option.value) continue;
    if (!looksSecret(option.key)) continue;
    const name = uniqueEnvName(option.key, used);
    used.add(name);
    out.push({ name, value: option.value, key: option.key });
  }
  return out;
}

function looksSecret(key: string): boolean {
  return /pass(word)?|secret|token|apikey|api[._-]?key|accesskey|credential/i.test(key);
}

/// `-Ddatabase.password` -> `DATABASE_PASSWORD`, uniquely.
export function uniqueEnvName(key: string, used: ReadonlySet<string>): string {
  const base =
    key
      .replace(/^-+D?/, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase() || 'VALUE';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/// Rewrite the options that hold a lifted value to refer to it instead.
export function applyMachineValues(
  options: readonly ServiceOption[],
  lifted: readonly { name: string; key: string }[],
): ServiceOption[] {
  const byKey = new Map(lifted.map((l) => [l.key, l.name]));
  return options.map((option) =>
    byKey.has(option.key) ? { ...option, value: `\${${byKey.get(option.key)}}` } : option,
  );
}

// ── small helpers ───────────────────────────────────────────────────────────

function attr(xml: string, re: RegExp): string | null {
  return re.exec(xml)?.[1] ?? null;
}

function option(xml: string, name: string): string | null {
  const re = new RegExp(`<option\\s+name="${name}"\\s+value="([\\s\\S]*?)"\\s*/>`);
  return re.exec(xml)?.[1] ?? null;
}

function quoted(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1] ?? null;
}

function lastSegment(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/// A spec's worth of what an import knows, for the caller to finish.
export function toSpecPatch(service: ImportedService): Partial<ServiceSpec> {
  return {
    name: service.name,
    options: service.options,
    group: service.group,
    port: service.port,
    debugPort: service.debugPort,
    subpath: service.subpath,
    config: Object.keys(service.env).length > 0 ? { inject: service.env } : {},
  };
}
