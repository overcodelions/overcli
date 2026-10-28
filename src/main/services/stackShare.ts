// Turning a stack into a file someone else can run, and back.
//
// The shape and the reasons for it are in `shared/stackShare.ts`. What lives
// here is the work: which parts of a spec only mean something on this machine,
// how a credential typed into an option is recognised and taken out, and how
// an incoming stack's repos and names become this machine's checkouts and ids.
//
// Pure, like the importers: git is asked by the caller and handed in as
// `remoteOf`, so every rule here can be pinned in a test.

import { isSecretName } from '../../shared/machineValues';
import {
  SHARED_STACK_FORMAT,
  type SharePreview,
  type SharedRepo,
  type SharedRepoMatch,
  type SharedService,
  type SharedStack,
} from '../../shared/stackShare';
import { uniqueEnvName } from './importers';
import type { ServiceBinding, ServiceOption, ServiceSpec } from './types';

export interface SharePlace {
  id: string;
  name: string;
  path: string;
}

/// Names that are filled in by overcli itself, never asked for.
const BUILT_IN = new Set(['SERVICE_CONFIG_DIR', 'HOME']);

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/// A value that is already a reference, or holds one: `${DB_PASSWORD}`,
/// `$DB_PASSWORD`, `Bearer ${TOKEN}`. A `$` inside a typed password
/// (`Pa$sword1`) is not one.
const IS_REFERENCE = /^\$[A-Za-z_][A-Za-z0-9_]*$|\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
/// `--db.password=hunter2`, `-Dapi.key=…`, `TOKEN=…`: an argument that is a
/// name and its value.
const KEY_VALUE_ARG = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]*)$/;

/// `git@github.com:acme/billing.git` and `https://github.com/acme/billing` are
/// one repo. Host and path, lower case, no scheme, user or `.git`.
export function normalizeRemote(url: string | undefined): string | undefined {
  const raw = url?.trim();
  if (!raw) return undefined;
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(raw);
  let hostAndPath: string;
  if (scp) {
    hostAndPath = `${scp[1]}/${scp[2]}`;
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/i.exec(raw);
    if (!m) return undefined;
    hostAndPath = `${m[1].replace(/:\d+$/, '')}/${m[2]}`;
  }
  return hostAndPath.replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase();
}

/// Build the file for some or all of a stack. A copy brings its base along —
/// on its own it is a list of differences from nothing.
export function buildSharedStack(args: {
  name: string;
  services: readonly ServiceSpec[];
  bindings: readonly ServiceBinding[];
  projects: readonly SharePlace[];
  /// Absent means everything.
  serviceIds?: readonly string[];
  /// Off unless asked: a pin says which branch YOU keep a service on.
  includePins?: boolean;
  remoteOf: (checkout: string) => string | undefined;
  home: string;
  now?: Date;
}): SharePreview {
  const byId = new Map(args.services.map((s) => [s.id, s]));
  const wanted = new Set(args.serviceIds ?? args.services.map((s) => s.id));
  for (const id of [...wanted]) {
    let base = byId.get(id)?.copyOf;
    while (base && byId.has(base) && !wanted.has(base)) {
      wanted.add(base);
      base = byId.get(base)?.copyOf;
    }
  }
  // In the stack's own order, so the file reads the way the list does.
  const chosen = args.services.filter((s) => wanted.has(s.id));

  // Asked once per checkout: a repo holding twenty modules is one remote.
  const remotes = new Map<string, string | undefined>();
  const remoteOf = (checkout: string) => {
    if (!remotes.has(checkout)) remotes.set(checkout, args.remoteOf(checkout));
    return remotes.get(checkout);
  };

  const repos: Record<string, SharedRepo> = {};
  const repoKeyFor = new Map<string, string>();
  const repoOf = (spec: ServiceSpec): string => {
    const project = args.projects.find((p) => p.id === spec.projectId);
    const checkout = project?.path ?? args.bindings.find((b) => b.serviceId === spec.id)?.path ?? '';
    const remote = normalizeRemote(remoteOf(checkout));
    const identity = remote ?? checkout;
    const known = repoKeyFor.get(identity);
    if (known) return known;
    // A worktree's folder is named for its branch; the project's is the repo's.
    const folder = project?.name ?? lastSegment(checkout) ?? 'repo';
    const base = slug(remote ? (lastSegment(remote) ?? folder) : folder) || 'repo';
    let key = base;
    for (let n = 2; key in repos; n++) key = `${base}-${n}`;
    repos[key] = remote ? { name: folder, remote } : { name: folder };
    repoKeyFor.set(identity, key);
    return key;
  };

  const nameOf = (id: string) => (wanted.has(id) ? byId.get(id)?.name : undefined);
  // Only where the home folder ends: with home /home/al, /home/alex is
  // someone else's.
  const homeAt = args.home.length > 1 ? new RegExp(`${args.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g') : null;
  const unhome = (text: string) => (homeAt ? text.replace(homeAt, () => '${HOME}') : text);

  // One name per secret value: the same password in six options is one blank
  // to fill, not six.
  const referenced = new Set<string>();
  const noteRefs = (text: string | undefined) => {
    for (const m of (text ?? '').matchAll(REFERENCE)) if (!BUILT_IN.has(m[1])) referenced.add(m[1]);
  };
  for (const spec of chosen) {
    for (const o of spec.options ?? []) noteRefs(o.value);
    for (const v of Object.values(spec.config.inject ?? {})) noteRefs(v);
    for (const a of spec.command) noteRefs(a);
  }
  const used = new Set(referenced);
  const scrubbedBy = new Map<string, string>();
  // Where each blank was taken from, so the sheet can say: a key that only
  // looks like a credential (`jwt.key=local-unused`) is then easy to spot.
  const origins = new Map<string, { service: string; key: string }[]>();
  const scrub = (service: string, key: string, value: string): string => {
    if (!value || IS_REFERENCE.test(value) || !isSecretName(key)) return unhome(value);
    const identity = `${key}\u0000${value}`;
    let name = scrubbedBy.get(identity);
    if (!name) {
      name = uniqueEnvName(key, used);
      used.add(name);
      scrubbedBy.set(identity, name);
    }
    origins.set(name, [...(origins.get(name) ?? []), { service, key }]);
    return `\${${name}}`;
  };

  let linked = 0;
  let pinned = 0;
  let configDir = 0;
  const services: SharedService[] = chosen.map((spec) => {
    const {
      id: _id,
      projectId: _projectId,
      importedFrom: _importedFrom,
      pinnedRef,
      debugEnabled: _debugEnabled,
      deps,
      copyOf,
      options,
      config,
      command,
      ...rest
    } = spec;
    if (pinnedRef && !args.includePins) pinned += 1;
    const { link, render, inject, ...keptConfig } = config;
    if (Object.keys(link ?? {}).length + Object.keys(render ?? {}).length > 0) linked += 1;
    if (Object.values(inject ?? {}).some((v) => v.includes('${SERVICE_CONFIG_DIR}'))) configDir += 1;

    const out: SharedService = {
      ...rest,
      repo: repoOf(spec),
      ...(pinnedRef && args.includePins ? { pinnedRef } : {}),
      command: command.map((arg) => {
        const kv = KEY_VALUE_ARG.exec(arg);
        return kv ? `${kv[1]}=${scrub(spec.name, kv[1], kv[2])}` : unhome(arg);
      }),
      config: {
        ...keptConfig,
        ...(inject
          ? { inject: Object.fromEntries(Object.entries(inject).map(([k, v]) => [k, scrub(spec.name, k, v)])) }
          : {}),
      },
    };
    if (options) {
      out.options = options.map((o): ServiceOption =>
        o.value === undefined ? o : { ...o, value: scrub(spec.name, o.key, o.value) },
      );
    }
    const depNames = (deps ?? []).map(nameOf).filter((n): n is string => !!n);
    if (depNames.length > 0) out.deps = depNames;
    const baseName = copyOf ? nameOf(copyOf) : undefined;
    if (baseName) out.copyOf = baseName;
    if (out.ready.kind === 'command') out.ready = { ...out.ready, command: out.ready.command.map(unhome) };
    return out;
  });

  const scrubbed = [...origins.entries()]
    .map(([name, from]) => ({ name, from }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const stack: SharedStack = {
    format: SHARED_STACK_FORMAT,
    name: args.name,
    exportedAt: (args.now ?? new Date()).toISOString(),
    repos,
    services,
    values: [...new Set([...referenced, ...scrubbed.map((s) => s.name)])].sort(),
  };

  const dropped: string[] = [];
  if (linked > 0) dropped.push(`linked or rendered config files on ${plural(linked, 'service')}`);
  if (configDir > 0) dropped.push(`what is in the config folder of ${plural(configDir, 'service')}`);
  if (pinned > 0) dropped.push(`branch pins on ${plural(pinned, 'service')}`);

  return { stack, text: `${JSON.stringify(stack, null, 2)}\n`, scrubbed, dropped };
}

/// Read a file someone sent. Checked field by field: it came from outside, and
/// what it holds becomes commands this machine runs.
export function parseSharedStack(text: string): { stack: SharedStack } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'This is not a shared stack file — it is not JSON.' };
  }
  const doc = parsed as Partial<SharedStack> | null;
  if (!doc || typeof doc !== 'object' || doc.format !== SHARED_STACK_FORMAT) {
    return { error: `This is not a shared stack file — expected format "${SHARED_STACK_FORMAT}".` };
  }
  if (!doc.repos || typeof doc.repos !== 'object' || !Array.isArray(doc.services)) {
    return { error: 'The file has no repos or services.' };
  }
  const repos: Record<string, SharedRepo> = {};
  for (const [key, repo] of Object.entries(doc.repos)) {
    if (!repo || typeof repo.name !== 'string') return { error: `Repo "${key}" has no name.` };
    repos[key] = typeof repo.remote === 'string' ? { name: repo.name, remote: repo.remote } : { name: repo.name };
  }
  const services: SharedService[] = [];
  for (const raw of doc.services as unknown[]) {
    const s = raw as Partial<SharedService> | null;
    if (!s || typeof s.name !== 'string' || !s.name.trim()) return { error: 'A service has no name.' };
    if (typeof s.repo !== 'string' || !(s.repo in repos)) {
      return { error: `${s.name} names a repo the file does not list.` };
    }
    if (!Array.isArray(s.command) || !s.command.every((a) => typeof a === 'string')) {
      return { error: `${s.name} has no command.` };
    }
    if (typeof s.runner !== 'string') return { error: `${s.name} has no runner.` };
    const nested = nestedError(s);
    if (nested) return { error: `${s.name} ${nested}.` };
    services.push({
      ...(s as SharedService),
      ready: s.ready && typeof s.ready === 'object' ? s.ready : { kind: 'none' },
      selfReloads: s.selfReloads === true,
      config: s.config && typeof s.config === 'object' ? s.config : {},
    });
  }
  return {
    stack: {
      format: SHARED_STACK_FORMAT,
      name: typeof doc.name === 'string' ? doc.name : 'Shared stack',
      exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
      repos,
      services,
      values: Array.isArray(doc.values) ? doc.values.filter((v): v is string => typeof v === 'string') : [],
    },
  };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/// What a service's nested fields get wrong, if anything: they become a
/// probe, flags and variables here, so a missing one is a refusal now rather
/// than a crash on import.
function nestedError(s: Partial<SharedService>): string | undefined {
  const r = s.ready as unknown as Record<string, unknown> | undefined;
  if (r !== undefined && r !== null) {
    if (typeof r !== 'object') return 'has a ready check that is not one';
    const port = typeof r.port === 'number' && Number.isInteger(r.port);
    const ok =
      r.kind === 'none' ||
      (r.kind === 'tcp' && port) ||
      (r.kind === 'http' && port && typeof r.path === 'string') ||
      (r.kind === 'log' && typeof r.pattern === 'string') ||
      (r.kind === 'command' && isStrings(r.command) && (r.command as string[]).length > 0);
    if (!ok) return `has a ${typeof r.kind === 'string' ? `"${r.kind}" ` : ''}ready check with parts missing`;
  }
  if (s.options !== undefined && !(Array.isArray(s.options) && s.options.every((o) => o && typeof o.key === 'string' && (o.value === undefined || typeof o.value === 'string')))) {
    return 'has options that are not name and value';
  }
  if (s.deps !== undefined && !isStrings(s.deps)) return 'has dependencies that are not names';
  if (s.copyOf !== undefined && typeof s.copyOf !== 'string') return 'is a copy of something that is not a name';
  const inject = (s.config as { inject?: unknown } | undefined)?.inject;
  if (inject !== undefined && (!inject || typeof inject !== 'object' || !Object.values(inject).every((v) => typeof v === 'string'))) {
    return 'has variables that are not text';
  }
  return undefined;
}

/// Each repo of an incoming stack against this machine's projects: by remote
/// first, then — for a repo with none — by folder name.
export function matchRepos(
  stack: SharedStack,
  projects: readonly SharePlace[],
  remoteOf: (checkout: string) => string | undefined,
): SharedRepoMatch[] {
  const remotes = new Map<string, SharePlace>();
  for (const project of projects) {
    const remote = normalizeRemote(remoteOf(project.path));
    if (remote && !remotes.has(remote)) remotes.set(remote, project);
  }
  return Object.entries(stack.repos).map(([key, repo]) => {
    const found =
      (repo.remote ? remotes.get(repo.remote) : undefined) ??
      (repo.remote ? undefined : projects.find((p) => p.name === repo.name || lastSegment(p.path) === repo.name));
    return {
      key,
      repo,
      services: stack.services.filter((s) => s.repo === key).length,
      ...(found ? { match: { projectId: found.id, path: found.path } } : {}),
    };
  });
}

/// The specs an incoming stack becomes here, each with the checkout it binds
/// to. A service whose repo has no place, or that this stack already has, is
/// left out with why.
export function specsFromShared(args: {
  stack: SharedStack;
  places: Record<string, { projectId?: string; path: string } | undefined>;
  existing: readonly ServiceSpec[];
  home: string;
  idFor: (owner: string, name: string, subpath?: string) => string;
}): { specs: { spec: ServiceSpec; path: string }[]; skipped: { name: string; reason: string }[] } {
  const skipped: { name: string; reason: string }[] = [];
  const rehome = (text: string) => text.split('${HOME}').join(args.home);
  const existingIds = new Set(args.existing.map((s) => s.id));
  const existingByName = new Map(args.existing.map((s) => [s.name, s.id]));

  // Ids first, so deps and copies can point at services later in the file.
  const placed: { service: SharedService; id: string; place: { projectId?: string; path: string } }[] = [];
  for (const service of args.stack.services) {
    const place = args.places[service.repo];
    if (!place) {
      skipped.push({ name: service.name, reason: `${args.stack.repos[service.repo]?.name ?? service.repo} is not on this machine` });
      continue;
    }
    const id = args.idFor(place.projectId ?? `shared-${slug(service.repo)}`, service.name, service.subpath);
    if (existingIds.has(id) || existingByName.has(service.name)) {
      skipped.push({ name: service.name, reason: 'already in this stack' });
      continue;
    }
    placed.push({ service, id, place });
  }
  const idByName = new Map(placed.map((p) => [p.service.name, p.id]));
  const resolve = (name: string) => idByName.get(name) ?? existingByName.get(name);

  const specs: { spec: ServiceSpec; path: string }[] = [];
  for (const { service, id, place } of placed) {
    const { repo: _repo, deps, copyOf, command, options, config, ...rest } = service;
    const base = copyOf ? resolve(copyOf) : undefined;
    if (copyOf && !base) {
      skipped.push({ name: service.name, reason: `it is a copy of ${copyOf}, which was not added` });
      continue;
    }
    const depIds = (deps ?? []).map(resolve).filter((d): d is string => !!d && d !== id);
    const spec: ServiceSpec = {
      ...rest,
      id,
      ...(place.projectId ? { projectId: place.projectId } : {}),
      command: command.map(rehome),
      config: {
        ...config,
        ...(config.inject
          ? { inject: Object.fromEntries(Object.entries(config.inject).map(([k, v]) => [k, rehome(String(v))])) }
          : {}),
      },
      ...(options
        ? { options: options.map((o) => (o.value === undefined ? o : { ...o, value: rehome(o.value) })) }
        : {}),
      ...(depIds.length > 0 ? { deps: depIds } : {}),
      ...(base ? { copyOf: base } : {}),
    };
    if (spec.ready.kind === 'command') spec.ready = { ...spec.ready, command: spec.ready.command.map(rehome) };
    specs.push({ spec, path: place.path });
  }
  return { specs, skipped };
}

function lastSegment(p: string): string | undefined {
  return p.split(/[\\/]/).filter(Boolean).pop();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
