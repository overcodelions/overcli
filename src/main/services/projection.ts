// Getting a service's local config into whichever checkout it is bound to.
//
// This is the part that actually hurts today. A service's local properties
// belong to the SERVICE — one `application-local.yml`, one set of env — but
// every runtime wants them in a different shape at a different path inside
// the checkout, which is exactly the thing that keeps being swapped out from
// under it. So config is stored once per service, outside every checkout, and
// projected in at start time by one of three mechanisms:
//
//   inject — hand it to the process as env. Nothing is written into the
//            checkout at all, so the worktree cannot go dirty. Always
//            preferred; covers anything twelve-factor-ish, and Spring via
//            SPRING_CONFIG_ADDITIONAL_LOCATION.
//   link   — symlink the file in, for runtimes that insist on a fixed path.
//            One source of truth shared by every worktree of the repo.
//   render — write a file derived per binding, for the rare config that must
//            genuinely differ between checkouts (an Apache vhost's
//            DocumentRoot, a substituted port).
//
// Planning reads only enough disk to resolve the checkout; `applyProjection`
// is what writes.
//
// Every one of these calls is promise-based, and deliberately so: this module
// runs in the MAIN process, on the same event loop as every window. The
// synchronous version of it stalled the whole UI for the length of a stat
// storm each time a service launched — which is every restart, and a restart
// is something the user is watching.

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { ServiceBinding, ServiceSpec } from './types';

/// The slice of `fs` this module uses, so tests can drive it with a fake and
/// the real thing needs no wrapper.
export interface ProjectionFs {
  /// Follows symlinks, so a dangling link reads as absent — see `lexists` for
  /// the cases where that distinction matters.
  exists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  readFile(p: string, enc: 'utf8'): Promise<string>;
  writeFile(p: string, data: string, enc: 'utf8'): Promise<void>;
  mkdir(p: string, opts: { recursive: true }): Promise<void>;
  symlink(target: string, linkPath: string, type: 'file' | 'dir'): Promise<void>;
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>;
  stat(p: string): Promise<{ isDirectory(): boolean }>;
  readlink(p: string): Promise<string>;
  unlink(p: string): Promise<void>;
}

const realFs: ProjectionFs = {
  async exists(p) {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (p) => fsp.realpath(p),
  readFile: (p, enc) => fsp.readFile(p, enc),
  writeFile: (p, data, enc) => fsp.writeFile(p, data, enc),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  symlink: (target, linkPath, type) => fsp.symlink(target, linkPath, type),
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  readlink: (p) => fsp.readlink(p),
  unlink: (p) => fsp.unlink(p),
};

export interface LinkPlan {
  /// Absolute path inside the checkout where the file must appear.
  linkPath: string;
  /// Absolute path of the single shared source file.
  target: string;
  /// Path relative to the checkout — what goes in the git exclude file.
  relative: string;
}

export interface RenderPlan {
  filePath: string;
  templatePath: string;
  relative: string;
}

export interface ProjectionPlan {
  /// The checkout everything is projected into, already resolved to a real
  /// path.
  cwd: string;
  env: Record<string, string>;
  /// The service's command with the checkout placeholders filled in, so one
  /// written as `ln -sfn ${CHECKOUT} …` follows the service to whichever
  /// worktree it is switched to.
  command: string[];
  links: LinkPlan[];
  renders: RenderPlan[];
}

/// Thrown when a launch path would put a process somewhere that breaks it.
export class ProjectionError extends Error {}

/// Resolve the directory a process should actually be launched in.
///
/// A workspace's symlink root (one link per member project, under userData)
/// exists so the AGENT's cwd can see every member side by side. It is the
/// wrong place to launch a process from: node resolves modules by walking up
/// and would climb out of the repo into userData, git commands find the wrong
/// root, and relative paths in config resolve somewhere nobody thinks to
/// look. So every launch resolves through the symlink to the real checkout,
/// and a path that still sits under a known symlink root is refused rather
/// than quietly producing a process that misbehaves in three subtle ways.
export async function resolveLaunchCwd(
  checkoutPath: string,
  opts: { symlinkRoots?: readonly string[]; fs?: ProjectionFs } = {},
): Promise<string> {
  const fs = opts.fs ?? realFs;
  if (!(await fs.exists(checkoutPath))) {
    throw new ProjectionError(`Checkout no longer exists: ${checkoutPath}`);
  }
  const real = await fs.realpath(checkoutPath);
  for (const root of opts.symlinkRoots ?? []) {
    if (isInside(real, root)) {
      throw new ProjectionError(
        `Refusing to launch inside the workspace symlink root (${root}). ` +
          'Bind the service to the real checkout instead.',
      );
    }
  }
  return real;
}

/// Whether `child` is `parent` or sits beneath it. Compares path segments so
/// `/a/bc` is not treated as inside `/a/b`.
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/// What projecting this service into this binding would do. Nothing is
/// written, so the pane can show it before anything happens and tests can
/// assert on it directly — only the checkout itself is resolved on disk.
export async function planProjection(
  spec: ServiceSpec,
  binding: ServiceBinding,
  opts: {
    symlinkRoots?: readonly string[];
    fs?: ProjectionFs;
    port?: number;
    /// Where this service's own config lives. Substituted wherever
    /// `${SERVICE_CONFIG_DIR}` appears — in a link or render TARGET as much as
    /// in an injected variable. Leaving it out of the targets produced a
    /// symlink to a literal `${SERVICE_CONFIG_DIR}` directory next to the app.
    configDir?: string;
  } = {},
): Promise<ProjectionPlan> {
  const cwd = await resolveLaunchCwd(binding.path, opts);
  const root = spec.subpath ? path.join(cwd, spec.subpath) : cwd;
  const port = opts.port ?? spec.port;
  const vars = { root, cwd, ref: binding.ref, port, configDir: opts.configDir };

  // Always there, so a script can find the checkout without being told the
  // placeholder syntax. An injected variable of the same name still wins.
  const env: Record<string, string> = {
    OVERCLI_CHECKOUT: cwd,
    OVERCLI_ROOT: root,
    OVERCLI_REF: binding.ref,
    ...(port === undefined ? {} : { OVERCLI_PORT: String(port) }),
  };
  for (const [key, value] of Object.entries(spec.config.inject ?? {})) {
    env[key] = substitute(value, vars);
  }
  // Unset placeholders stay as written here: a shell command's own `${PORT}`
  // is its business, not a blank.
  const command = spec.command.map((arg) => substitute(arg, vars, { keepUnset: true }));

  const links: LinkPlan[] = Object.entries(spec.config.link ?? {}).map(([relative, target]) => ({
    relative,
    linkPath: path.join(root, relative),
    target: path.resolve(substitute(target, vars)),
  }));

  const renders: RenderPlan[] = Object.entries(spec.config.render ?? {}).map(
    ([relative, templatePath]) => ({
      relative,
      filePath: path.join(root, relative),
      templatePath: path.resolve(substitute(templatePath, vars)),
    }),
  );

  return { cwd, env, command, links, renders };
}

/// Replace the handful of placeholders a config value may carry. Deliberately
/// not a template language: these are what a local config needs, and anything
/// cleverer belongs in a rendered file.
export function substitute(
  value: string,
  vars: { root: string; cwd: string; ref: string; port?: number; configDir?: string },
  opts: { keepUnset?: boolean } = {},
): string {
  // Functions, not strings: a path with a `$` in it is not a replacement pattern.
  const fill = (known: string | undefined) => (whole: string) =>
    known ?? (opts.keepUnset ? whole : '');
  return value
    .replace(/\$\{CHECKOUT\}/g, fill(vars.cwd))
    .replace(/\$\{ROOT\}/g, fill(vars.root))
    .replace(/\$\{REF\}/g, fill(vars.ref))
    .replace(/\$\{SERVICE_CONFIG_DIR\}/g, fill(vars.configDir))
    .replace(/\$\{PORT\}/g, fill(vars.port === undefined ? undefined : String(vars.port)));
}

/// Carry out a plan: create the symlinks, render the templates, and make sure
/// git ignores both. Returns the paths it wrote, for the log.
export async function applyProjection(
  plan: ProjectionPlan,
  opts: { fs?: ProjectionFs } = {},
): Promise<{ linked: string[]; rendered: string[] }> {
  const fs = opts.fs ?? realFs;
  const linked: string[] = [];
  const rendered: string[] = [];

  for (const link of plan.links) {
    await fs.mkdir(path.dirname(link.linkPath), { recursive: true });

    // The file being linked TO has to exist, or the link is dangling and the
    // runtime reports a missing file rather than an empty one. An empty file
    // in the service's config folder is also the invitation to edit it.
    await fs.mkdir(path.dirname(link.target), { recursive: true });
    if (!(await fs.exists(link.target))) await fs.writeFile(link.target, '', 'utf8');

    // `exists` FOLLOWS symlinks, so a link left over from a failed attempt
    // — pointing at something that no longer exists — reads as absent and the
    // symlink call then fails with EEXIST. Ask about the link itself.
    const present = await lexists(fs, link.linkPath);
    if (present) {
      // Already ours and pointing at the right file: leave it. Pointing
      // somewhere else: replace it, since the service's config is the
      // authority. A real file (not a symlink) is the user's own, and
      // clobbering it would silently destroy local config they wrote — so
      // that one is left alone and reported by its absence from `linked`.
      if (!(await fs.lstat(link.linkPath)).isSymbolicLink()) continue;
      if ((await fs.readlink(link.linkPath)) === link.target) {
        linked.push(link.linkPath);
        continue;
      }
      await fs.unlink(link.linkPath);
    }
    await fs.symlink(link.target, link.linkPath, 'file');
    linked.push(link.linkPath);
  }

  for (const render of plan.renders) {
    await fs.mkdir(path.dirname(render.filePath), { recursive: true });
    await fs.writeFile(render.filePath, await fs.readFile(render.templatePath, 'utf8'), 'utf8');
    rendered.push(render.filePath);
  }

  return { linked, rendered };
}

/// The git directory shared by every worktree of a repo.
///
/// This matters more than it looks: `.git/info/exclude` lives in the COMMON
/// directory, so writing the ignore entry once covers every worktree that
/// exists now and every one created later. A linked worktree's `.git` is a
/// file pointing at `<common>/worktrees/<name>`, whose `commondir` points back
/// up — follow both and the projected files never show as untracked in any
/// checkout.
export async function gitCommonDir(
  checkout: string,
  opts: { fs?: ProjectionFs } = {},
): Promise<string | null> {
  const fs = opts.fs ?? realFs;
  const dotGit = path.join(checkout, '.git');
  if (!(await fs.exists(dotGit))) return null;

  let gitDir = dotGit;
  // A linked worktree's `.git` is a file: "gitdir: /abs/path".
  if (!(await isDirectory(fs, dotGit))) {
    const pointer = (await fs.readFile(dotGit, 'utf8')).trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) return null;
    gitDir = path.resolve(checkout, match[1]);
  }

  const commonFile = path.join(gitDir, 'commondir');
  if (await fs.exists(commonFile)) {
    return path.resolve(gitDir, (await fs.readFile(commonFile, 'utf8')).trim());
  }
  return gitDir;
}

/// Add the projected paths to the repo's shared exclude file, once. Returns
/// the entries it added — empty when they were all already there, which is
/// the common case after the first bind.
export async function ensureExcluded(
  checkout: string,
  relatives: readonly string[],
  opts: { fs?: ProjectionFs } = {},
): Promise<string[]> {
  const fs = opts.fs ?? realFs;
  if (relatives.length === 0) return [];
  const common = await gitCommonDir(checkout, opts);
  if (!common) return [];

  const infoDir = path.join(common, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  const existing = (await fs.exists(excludeFile)) ? await fs.readFile(excludeFile, 'utf8') : '';
  const lines = new Set(
    existing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const added = relatives.map(toExcludePattern).filter((entry) => !lines.has(entry));
  if (added.length === 0) return [];

  await fs.mkdir(infoDir, { recursive: true });
  const header = existing.includes(EXCLUDE_HEADER) ? '' : `${EXCLUDE_HEADER}\n`;
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(excludeFile, `${existing}${prefix}${header}${added.join('\n')}\n`, 'utf8');
  return added;
}

const EXCLUDE_HEADER = '# overcli services — projected local config';

/// Anchor the pattern to the repo root. Unanchored, `config.yml` would also
/// hide a tracked `src/config.yml` the user cares about.
function toExcludePattern(relative: string): string {
  const normalized = relative.split(path.sep).join('/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/// Whether anything is at this path — a file, a directory, or a symlink
/// INCLUDING a broken one. `exists` answers no for a dangling link, which is
/// the one case that matters here.
async function lexists(fs: ProjectionFs, p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(fs: ProjectionFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
