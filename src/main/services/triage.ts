// Why it did not start.
//
// A failed service leaves a few hundred lines of output, and somewhere in them
// is one fact that explains everything. Finding it is a chore a machine should
// do, and mostly it does not need a model to do it — the useful diagnoses are
// comparisons between things overcli already knows: what we set against what
// the process reported, a placeholder against the file that defines it, this
// service's options against the ones sitting in a config file next door.
//
// So: deterministic rules first. They are cheap, offline, explainable and
// testable, which matters when the output is advice someone will act on. Each
// carries the evidence that justified it, the same way detection does — a
// diagnosis you cannot check is a diagnosis you will not trust twice.
//
// A model belongs after these, for the long tail, clearly marked as a guess.
// Nothing here is that.

import type { PortHolderKind } from '../../shared/services';
import type { ServiceFinding, ServiceSpec } from './types';

export type Finding = ServiceFinding;

export interface TriageContext {
  lines: readonly string[];
  spec: ServiceSpec;
  /// Environment actually handed to the process.
  env: Record<string, string>;
  /// How many startup options it resolved with.
  optionCount: number;
  binding?: { ref: string; path: string };
  /// Where a property key is defined in the repo, if anywhere.
  findDefinitions?: (key: string) => { file: string; presentInBinding: boolean }[];
  /// Local config present in the main checkout and missing from the binding.
  missingLocalConfig?: readonly string[];
  /// A config file next door that carries options this service does not.
  importOptions?: { source: string; count: number };
  /// Who holds the port, when something does.
  portOwner?: { port: number; holder: string; kind?: PortHolderKind };
}

/// Everything worth saying about a failure, most useful first.
export function triage(ctx: TriageContext): Finding[] {
  const findings: Finding[] = [
    ...missingDebugTool(ctx),
    ...profileContradiction(ctx),
    ...unresolvedPlaceholder(ctx),
    ...missingConfig(ctx),
    ...portTaken(ctx),
    ...missingCommand(ctx),
    ...noOptions(ctx),
];

  // One cause per id: a placeholder reported four times is one problem.
  const seen = new Set<string>();
  const unique = findings.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));

  // Only when nothing else had anything to say. A failure with a real message
  // in it is not silent, however few lines it took to get there.
  return unique.length > 0 ? unique : silentExit(ctx);
}

function missingDebugTool(ctx: TriageContext): Finding[] {
  if (!ctx.spec.debugEnabled) return [];
  const text = ctx.lines.join('\n');
  if (ctx.spec.debugKind === 'debugpy' && /No module named (?:['"])?debugpy|ModuleNotFoundError.*debugpy/i.test(text)) {
    return [{
      id: 'missing-debugpy',
      title: 'Python debugging needs debugpy in this environment',
      detail: 'Install debugpy in the same virtual environment that runs this service, then start it with the debugger again.',
      evidence: ctx.lines.filter((l) => /debugpy/i.test(l)).slice(0, 2),
    }];
  }
  if (ctx.spec.debugKind === 'delve' && /(?:spawn\s+)?dlv\s+ENOENT|dlv: command not found/i.test(text)) {
    return [{
      id: 'missing-delve',
      title: 'Go debugging needs Delve',
      detail: 'Install the dlv command and make sure it is on the PATH Overcli launches with, then start it with the debugger again.',
      evidence: ctx.lines.filter((l) => /dlv|ENOENT/i.test(l)).slice(0, 2),
    }];
  }
  return [];
}

// ── we set it, the process disagrees ────────────────────────────────────────

/// Spring announces the profiles it came up on. When that is not what we asked
/// for, everything downstream reads the wrong file — and the error it
/// eventually produces is about a placeholder, three hundred lines later, with
/// no hint that the profile was ever the problem.
function profileContradiction(ctx: TriageContext): Finding[] {
  const wanted = ctx.env.SPRING_PROFILES_ACTIVE;
  if (!wanted) return [];

  for (const line of ctx.lines) {
    const match = /following profiles are active:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const actual = match[1].trim();
    if (actual === wanted) return [];
    return [
      {
        id: 'profile-mismatch',
        title: `It started on the "${actual}" profile, not "${wanted}"`,
        detail:
          'Everything below follows from that — a different profile reads a different properties file. ' +
          'For Gradle this is usually the daemon: it reuses one started earlier, with an earlier environment, ' +
          'so variables set for this launch never reach the forked JVM. Add the profile as a startup option ' +
          `(-Dspring.profiles.active=${wanted}) to pass it directly.`,
        evidence: [line.trim(), `SPRING_PROFILES_ACTIVE=${wanted} was set for this launch`],
        action: 'edit-options',
      },
    ];
  }
  return [];
}

// ── a placeholder, and the file that defines it ─────────────────────────────

const PLACEHOLDER = /Could not resolve placeholder '([^']+)'/;

function unresolvedPlaceholder(ctx: TriageContext): Finding[] {
  for (const line of ctx.lines) {
    const match = PLACEHOLDER.exec(line);
    if (!match) continue;
    const key = match[1];
    const definitions = ctx.findDefinitions?.(key) ?? [];

    if (definitions.length === 0) {
      return [
        {
          id: `placeholder-${key}`,
          title: `Nothing defines ${key}`,
          detail:
            'It is not in any properties file in this checkout, so it has to come from a startup option. ' +
            'A run configuration or script that starts this service elsewhere will have it.',
          evidence: [line.trim()],
          action: ctx.importOptions ? 'import-options' : 'edit-options',
        },
      ];
    }

    const missing = definitions.filter((d) => !d.presentInBinding);
    if (missing.length > 0) {
      return [
        {
          id: `placeholder-${key}`,
          title: `${key} is defined in a file this checkout does not have`,
          detail:
            'The file is gitignored, so it exists in the main checkout and in no worktree. ' +
            'overcli can link it across, which is what the file being local rather than committed requires.',
          evidence: [line.trim(), ...missing.map((d) => `${d.file} — not in ${ctx.binding?.ref ?? 'this checkout'}`)],
          action: 'mirror-config',
        },
      ];
    }

    return [
      {
        id: `placeholder-${key}`,
        title: `${key} is defined, but was not read`,
        detail:
          'The file holding it is present, so something stopped it being loaded — most often the active profile: ' +
          'a profile only reads the properties file named for it.',
        evidence: [line.trim(), ...definitions.map((d) => `defined in ${d.file}`)],
      },
    ];
  }
  return [];
}

// ── config that never made it into the worktree ─────────────────────────────

function missingConfig(ctx: TriageContext): Finding[] {
  const missing = ctx.missingLocalConfig ?? [];
  if (missing.length === 0) return [];
  return [
    {
      id: 'missing-local-config',
      title: `${missing.length} local config file${missing.length === 1 ? '' : 's'} missing from this checkout`,
      detail:
        'These are gitignored, so they live in the main checkout and in no worktree. Linking them across is ' +
        'what running from a worktree requires.',
      evidence: missing.slice(0, 5),
      action: 'mirror-config',
    },
  ];
}

// ── the ordinary ones ───────────────────────────────────────────────────────

/// The line saying a port was taken, and the port it names when it names one.
///
/// The output is the authority on which port: a service saved with the wrong
/// one sends the owner lookup to the wrong place, and whatever it finds there
/// gets blamed.
export function portInUse(lines: readonly string[]): { line: string; port?: number } | null {
  const line = lines.find((l) =>
    /EADDRINUSE|address already in use|port .* (is|was) already in use/i.test(l),
  );
  if (!line) return null;
  const match = /\bport\s+(\d{2,5})\b/i.exec(line) ?? /:(\d{2,5})\b(?!.*:\d)/.exec(line);
  return { line, port: match ? Number(match[1]) : undefined };
}

function portTaken(ctx: TriageContext): Finding[] {
  const inUse = portInUse(ctx.lines);
  if (!inUse) return [];
  const port = ctx.portOwner?.port ?? inUse.port ?? ctx.spec.port;
  const owner = ctx.portOwner;

  const evidence = [inUse.line.trim()];
  const misfiled = inUse.port !== undefined && ctx.spec.port !== undefined && inUse.port !== ctx.spec.port;
  if (misfiled) evidence.push(`saved port: ${ctx.spec.port}`);
  const fixSaved = misfiled
    ? ` It is saved with :${ctx.spec.port} but tried :${inUse.port} — correct that in Settings.`
    : '';
  const base = { id: 'port-in-use', evidence, port };

  if (owner?.kind === 'self') {
    return [
      {
        ...base,
        title: `Port ${port} is overcli's own dev server`,
        detail:
          `${owner.holder} is the overcli you are using, so stopping it is not offered. This service needs ` +
          `another port.${fixSaved}`,
      },
    ];
  }
  if (owner?.kind === 'stale') {
    return [
      {
        ...base,
        title: `Port ${port} is held by a leftover copy of this service`,
        detail:
          `${owner.holder} is still running from this checkout, but whatever started it has exited. Stopping ` +
          `it is safe.${fixSaved}`,
        action: 'free-port',
      },
    ];
  }
  return [
    {
      ...base,
      title: owner
        ? `Port ${port} is held by ${owner.holder}`
        : port !== undefined
          ? `Port ${port} is already taken`
          : 'Its port is already taken',
      detail:
        (owner
          ? 'Check what it is before stopping it — it may be another project, or this one run from a terminal. '
          : '') +
        `Stop it, or run this one on an offset port.${fixSaved}`,
      action: 'free-port',
    },
  ];
}

function missingCommand(ctx: TriageContext): Finding[] {
  // npm reports a missing package.json as ENOENT too — but npm itself ran. A
  // missing FILE means the command ran in the wrong folder, and blaming PATH
  // sends people looking in the wrong place.
  const fileHit = ctx.lines
    .map((line) => ({ line, file: /no such file or directory, (?:open|stat|lstat|scandir) '([^']+)'/i.exec(line)?.[1] }))
    .find((h) => h.file);
  if (fileHit?.file) {
    const slash = fileHit.file.lastIndexOf('/');
    const name = fileHit.file.slice(slash + 1);
    const dir = slash > 0 ? fileHit.file.slice(0, slash) : fileHit.file;
    return [
      {
        id: 'missing-file',
        title: `${name} is not in ${dir}`,
        detail:
          `${ctx.spec.command[0]} ran, but not in the folder it expected. If the app lives in a subfolder ` +
          'of the repo, it has to run from that subfolder.',
        evidence: [fileHit.line.trim(), `command: ${ctx.spec.command.join(' ')}`],
        action: 'edit-options',
      },
    ];
  }

  const hit = ctx.lines.find((l) => /ENOENT|command not found|no such file or directory/i.test(l));
  if (!hit) return [];
  return [
    {
      id: 'missing-command',
      title: `${ctx.spec.command[0]} could not be run`,
      detail:
        'The command is not on the PATH overcli launches with, which is not always the PATH your shell has — ' +
        'a version manager that loads from a shell profile is the usual reason. An absolute path always works.',
      evidence: [hit.trim(), `command: ${ctx.spec.command.join(' ')}`],
      action: 'edit-options',
    },
  ];
}

/// A service with no options at all, next to a config file that has fifty.
function noOptions(ctx: TriageContext): Finding[] {
  if (ctx.optionCount > 0 || !ctx.importOptions || ctx.importOptions.count === 0) return [];
  return [
    {
      id: 'no-options',
      title: `This service has no startup options, and ${ctx.importOptions.source} has ${ctx.importOptions.count}`,
      detail:
        'overcli worked out how to start it by reading the build file, which says nothing about how it is ' +
        'configured. Importing brings those across as written.',
      evidence: [`${ctx.importOptions.count} options in ${ctx.importOptions.source}`],
      action: 'import-options',
    },
  ];
}

/// Exited without explaining itself. A last resort: saying this when there IS
/// an explanation on screen would be worse than saying nothing.
function silentExit(ctx: TriageContext): Finding[] {
  const meaningful = ctx.lines.filter((l) => l.trim() !== '').length;
  if (meaningful > 3) return [];
  return [
    {
      id: 'silent-exit',
      title: 'It stopped without saying anything',
      detail:
        'Nothing was written to output before it exited. A wrapper script that fails before it runs anything, ' +
        'or a command that needs a terminal, both look like this.',
      evidence: [`command: ${ctx.spec.command.join(' ')}`],
    },
  ];
}
