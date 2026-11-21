// Startup options, and the one thing that makes five services out of one
// module.
//
// `acme-proc-infra`, `-procs`, `-content`, `-dm` and `-procs-dm` are the same
// Gradle module launched five ways. Everything about them is identical — heap,
// database, spring profile, thirty-odd flags — except one or two options each.
// Modelling them as five unrelated services would mean bumping `-Xmx` in five
// places and getting it wrong in one; modelling them as one service with a
// dropdown would mean you cannot run two at once, which is exactly what that
// setup is for.
//
// So a service can be a COPY of another. It inherits the base's options and
// states only its own differences, and an option it restates wins. That is the
// whole mechanism, and it is deliberately dumb: no conditionals, no
// inheritance chains (a copy of a copy resolves against the original base).
//
// `${NAME}` in any value comes from the machine values file — one place for
// the handful of things that differ per developer rather than per service.

import fs from 'node:fs';
import path from 'node:path';

import type { ServiceOption, ServiceSpec } from './types';

/// A resolved option, ready to go on a command line.
export interface ResolvedOption {
  key: string;
  value?: string;
  /// Where it came from, so the pane can show what is shared and what is this
  /// copy's own doing.
  origin: 'shared' | 'own';
  /// True when this copy restated a key the base also sets.
  overrides?: boolean;
}

/// Everything this service will actually start with.
///
/// Order is deliberate: shared options first in their original order, then the
/// copy's additions. A restated key keeps the base's POSITION and takes the
/// copy's value, so a diff between two copies reads as a diff rather than a
/// reordering.
export function resolveOptions(
  specs: readonly ServiceSpec[],
  spec: ServiceSpec,
  machine: Readonly<Record<string, string>> = {},
): ResolvedOption[] {
  const base = spec.copyOf ? specs.find((s) => s.id === spec.copyOf) : undefined;
  const shared = (base?.options ?? []).filter(enabled);
  const own = (spec.options ?? []).filter(enabled);
  const ownByKey = new Map(own.map((o) => [o.key, o]));

  const out: ResolvedOption[] = [];
  const consumed = new Set<string>();

  for (const option of shared) {
    const override = ownByKey.get(option.key);
    if (override) {
      consumed.add(option.key);
      out.push({ key: option.key, value: substitute(override.value, machine), origin: 'own', overrides: true });
      continue;
    }
    out.push({ key: option.key, value: substitute(option.value, machine), origin: 'shared' });
  }

  for (const option of own) {
    if (consumed.has(option.key)) continue;
    out.push({ key: option.key, value: substitute(option.value, machine), origin: 'own' });
  }

  return out;
}

function enabled(option: ServiceOption): boolean {
  return option.enabled !== false;
}

/// Fill `${NAME}` from the machine values. An unknown name is left ALONE
/// rather than blanked: a service that starts with a literal `${DB_USER}` in
/// its arguments fails with a message naming the thing that is missing, which
/// is a far better morning than one that silently connects as no user.
///
/// A machine value can itself refer to another — `DATABASE_PASSWORD` holding
/// `${DB_PASSWORD}` is what an import of a script that passes references
/// used to leave behind — so a filled value is filled in turn. A name already
/// being expanded is left alone, which ends a cycle as an unresolved name
/// rather than a hang.
export function substitute(
  value: string | undefined,
  machine: Readonly<Record<string, string>>,
): string | undefined {
  if (value === undefined) return undefined;
  return expand(value, machine, new Set());
}

function expand(value: string, machine: Readonly<Record<string, string>>, expanding: ReadonlySet<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    name in machine && !expanding.has(name)
      ? expand(machine[name], machine, new Set(expanding).add(name))
      : whole,
  );
}

/// Machine values a set of services refers to but the file does not define.
/// Surfaced before a start rather than after a stack trace.
export function missingMachineValues(
  options: readonly ResolvedOption[],
): string[] {
  const missing = new Set<string>();
  for (const option of options) {
    for (const match of (option.value ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      missing.add(match[1]);
    }
  }
  return [...missing];
}

/// One option as it appears on a command line.
export function renderOption(option: Pick<ResolvedOption, 'key' | 'value'>): string {
  return option.value === undefined || option.value === '' ? option.key : `${option.key}=${option.value}`;
}

/// The full argv for a service, options and debugger included.
///
/// How options reach the process differs by runner and getting it wrong is
/// silent: Gradle's `bootRun` ignores JVM flags passed as plain arguments, so
/// they have to ride inside `-PjvmArgs="…"`, which is what the Tiltfile this
/// was modelled on does.
///
/// `-PjvmArgs` is only a convention, though: it reaches the JVM when the build
/// file reads it and vanishes when it does not — a service then boots on the
/// default profile with none of its options, and nothing says why. Given the
/// init script, the exact list also goes in `-PovercliJvmArgs`, and the script
/// adds whichever of them the build file did not already pass.
export function buildCommand(
  spec: ServiceSpec,
  options: readonly ResolvedOption[],
  gradleOptionsInit?: string,
): string[] {
  const rendered = options.map(renderOption);
  if (rendered.length === 0) return [...spec.command];

  const style = spec.optionStyle ?? defaultOptionStyle(spec);
  if (style === 'gradle-jvm-args') {
    const packed = `-PjvmArgs=${rendered.join(' ')}`;
    if (!gradleOptionsInit) return appendArgs(spec.command, [packed]);
    return appendArgs(spec.command, [
      packed,
      `-PovercliJvmArgs=${JSON.stringify(rendered)}`,
      '-I',
      gradleOptionsInit,
    ]);
  }
  return appendArgs(spec.command, rendered);
}

/// What the init script prints once it has made sure of the options. Triage
/// reads it back: present means the options reached bootRun, and a profile
/// mismatch after that is the app's doing, not the launch's.
export const GRADLE_OPTIONS_MARKER = '>>> OVERCLI OPTIONS:';

const GRADLE_OPTIONS_INIT = [
  '// Generated by Overcli. Changes are replaced.',
  '// Startup options reach bootRun through -PjvmArgs only when the build file',
  '// reads that property. This adds any it did not pass, so they arrive either way.',
  'allprojects {',
  '    afterEvaluate { p ->',
  "        def bootRun = p.tasks.findByName('bootRun')",
  "        def raw = p.findProperty('overcliJvmArgs')",
  '        if (bootRun && raw) {',
  '            bootRun.doFirst {',
  '                def wanted = new groovy.json.JsonSlurper().parseText(raw.toString()) as List',
  '                def have = (bootRun.jvmArgs ?: []) as List',
  '                def missing = wanted.findAll { !have.contains(it) }',
  '                if (missing) bootRun.jvmArgs(missing)',
  `                println "${GRADLE_OPTIONS_MARKER} \${wanted.size()} startup options on bootRun (\${wanted.size() - missing.size()} passed by the build file, \${missing.size()} added by Overcli)"`,
  '            }',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

/// Materialise the options adapter outside every checkout, the same way the
/// debug one is, so making sure of the options never dirties a branch.
export function ensureGradleOptionsInit(dataDir: string): string {
  const dir = path.join(dataDir, 'services', '_gradle');
  const file = path.join(dir, 'overcli-options.init.gradle');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== GRADLE_OPTIONS_INIT) {
    fs.writeFileSync(file, GRADLE_OPTIONS_INIT, { mode: 0o600 });
  }
  return file;
}

/// Arguments added to the end of a command. A command that runs through
/// `sh -c` takes them inside its script: put after it, they become `$0`, `$1`
/// of a script that never reads them, and every option silently vanished the
/// moment a clean step was chained in front of a bootRun. Inside, they land on
/// the script's last command — the run, after any setup chained before it.
/// Single-quoted, so a value is never expanded by the shell.
export function appendArgs(command: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return [...command];
  if (command.length === 3 && command[0] === 'sh' && command[1] === '-c') {
    return ['sh', '-c', `${command[2].trimEnd()} ${extra.map(shellQuote).join(' ')}`];
  }
  return [...command, ...extra];
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_.,:/=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/// What a runner needs when nobody has said. Gradle is the one that differs,
/// and it is the one that matters here.
export function defaultOptionStyle(spec: Pick<ServiceSpec, 'runner'>): 'argv' | 'gradle-jvm-args' {
  return spec.runner === 'gradle' ? 'gradle-jvm-args' : 'argv';
}

/// Parse a pasted block of flags into options — one per line or space
/// separated, `-Dkey=value`, `--flag=value` or a bare `--flag`. The way anyone
/// actually moves an existing setup in: copy the args out of the script that
/// has them today and paste.
export function parseOptions(text: string): ServiceOption[] {
  const out: ServiceOption[] = [];
  // A `#` comments out the REST OF THE LINE, not just its own token — the
  // scripts people paste from are shell scripts, and half of every one of them
  // is commentary.
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  // Split on whitespace but keep quoted values together, and drop the quotes.
  for (const token of stripped.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const cleaned = token.replace(/^['"]|['"]$/g, '').trim();
    if (!cleaned) continue;
    const eq = cleaned.indexOf('=');
    if (eq === -1) {
      out.push({ key: cleaned });
      continue;
    }
    out.push({ key: cleaned.slice(0, eq), value: cleaned.slice(eq + 1).replace(/^['"]|['"]$/g, '') });
  }
  return out;
}

/// Whether a machine value is a credential by its name. Lives in shared so the
/// pane defaults a new value the same way the engine migrates an old one.
export { isSecretName } from '../../shared/machineValues';

/// The copies of a service, for the nested list.
export function copiesOf(specs: readonly ServiceSpec[], serviceId: string): ServiceSpec[] {
  return specs.filter((s) => s.copyOf === serviceId);
}

/// A service's own options, with the base's shown for context. Drives the
/// Overrides tab, which is the only place the difference between five nearly
/// identical services is legible.
export function describeDifference(
  specs: readonly ServiceSpec[],
  spec: ServiceSpec,
): { shared: ServiceOption[]; own: ServiceOption[] } {
  const base = spec.copyOf ? specs.find((s) => s.id === spec.copyOf) : undefined;
  return { shared: base?.options ?? [], own: spec.options ?? [] };
}
