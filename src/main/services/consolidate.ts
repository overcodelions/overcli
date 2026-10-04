// Values typed into several services that belong in the machine values.
//
// Forty services each carrying `DB_HOST=localhost` is forty places to change
// it, and the reason machine values exist. This finds them and moves them: the
// value becomes one machine value, and every service that had it typed in
// refers to it as `${NAME}` instead.
//
// Only a value that really is common qualifies. The same name holding the same
// value wherever it appears — a name that holds a different value in even one
// service is not common, and moving the majority's value would quietly change
// what the odd one out starts with. Matching is by name, never by value alone:
// `DB_URL` and `DATABASE_URL` holding the same string might be the same thing,
// but two services that both say `local` are a coincidence.

import { createHash } from 'node:crypto';

import { uniqueEnvName } from './importers';
import { isSecretName, referencesTo, type MachineValueForm } from '../../shared/machineValues';
import type { ServiceSpec, SharedValueUse } from '../../shared/services';

/// A shared value as the engine sees it — the value always present. The pane
/// gets a copy without it when it is a secret.
export interface SharedValue {
  id: string;
  name: string;
  value: string;
  secret: boolean;
  uses: SharedValueUse[];
  existing?: 'same' | 'different';
}

/// Names that are each service's own by nature. Two services sharing a port
/// is a clash to fix, not a value to centralise.
const PER_SERVICE = /(^|_)(PORT|PWD|HOME|PATH)$|^SERVICE_CONFIG_DIR$/;

/// Values too plain to mean anything when they match: a flag's `true`, a `1`.
const TRIVIAL = /^(true|false|yes|no|on|off)$/i;

/// The machine value name a key would be stored under: `DB_HOST` stays
/// `DB_HOST`, `-Ddb.host` becomes `DB_HOST` — so the env var and the system
/// property that say the same thing land on one name.
export function machineNameFor(key: string): string {
  return uniqueEnvName(key, new Set());
}

/// Whether a typed-in value could be moved at all.
function movable(name: string, value: string | undefined): value is string {
  if (value === undefined || value.trim().length < 2) return false;
  if (TRIVIAL.test(value.trim())) return false;
  // Already a reference, or built from one: lifting it would store the text
  // `${OTHER}` under a new name.
  if (/\$\{?[A-Za-z_]/.test(value)) return false;
  return !PER_SERVICE.test(name);
}

/// Every value at least two services have typed in identically, across the
/// given stacks. `machine` is the current machine values, to tell a value that
/// can simply be referred to from one whose name is already taken.
export function findSharedValues(
  stacks: readonly { workspaceId: string; services: readonly ServiceSpec[] }[],
  machine: Readonly<Record<string, string>>,
): SharedValue[] {
  const byName = new Map<string, { values: Set<string>; uses: SharedValueUse[] }>();
  const note = (name: string, value: string, use: SharedValueUse) => {
    const entry = byName.get(name) ?? { values: new Set<string>(), uses: [] };
    entry.values.add(value);
    entry.uses.push(use);
    byName.set(name, entry);
  };

  for (const { workspaceId, services } of stacks) {
    for (const spec of services) {
      const at = { workspaceId, serviceId: spec.id, service: spec.name };
      // Own options only: a copy's inherited ones are already said once, on
      // its base.
      for (const option of spec.options ?? []) {
        if (option.enabled === false) continue;
        const name = machineNameFor(option.key);
        if (movable(name, option.value)) note(name, option.value, { ...at, kind: 'option', key: option.key });
      }
      for (const [key, value] of Object.entries(spec.config.inject ?? {})) {
        const name = machineNameFor(key);
        if (movable(name, value)) note(name, value, { ...at, kind: 'env', key });
      }
    }
  }

  const out: SharedValue[] = [];
  for (const [name, { values, uses }] of byName) {
    if (values.size !== 1) continue;
    const services = new Set(uses.map((u) => `${u.workspaceId}\u0000${u.serviceId}`));
    if (services.size < 2) continue;
    const [value] = values;
    const existing = name in machine ? (machine[name] === value ? 'same' : 'different') : undefined;
    out.push({
      id: sharedValueId(name, value),
      name,
      value,
      secret: isSecretName(name) || uses.some((u) => isSecretName(u.key)),
      uses,
      ...(existing ? { existing } : {}),
    });
  }
  return out.sort((a, b) => b.uses.length - a.uses.length || a.name.localeCompare(b.name));
}

/// Names that hold more than one value across these services, so nothing
/// was offered for them. Said in the sheet, so a missing row is explained.
export function differingNames(
  stacks: readonly { workspaceId: string; services: readonly ServiceSpec[] }[],
): string[] {
  const values = new Map<string, Set<string>>();
  for (const { services } of stacks) {
    for (const spec of services) {
      const pairs: [string, string | undefined][] = [
        ...(spec.options ?? []).filter((o) => o.enabled !== false).map((o) => [o.key, o.value] as [string, string | undefined]),
        ...Object.entries(spec.config.inject ?? {}),
      ];
      for (const [key, value] of pairs) {
        const name = machineNameFor(key);
        if (movable(name, value)) values.set(name, (values.get(name) ?? new Set()).add(value));
      }
    }
  }
  return [...values].filter(([, v]) => v.size > 1).map(([name]) => name).sort();
}

/// Stable across a re-scan, so the pane can send back which ones it chose
/// without sending a secret's value back with them.
function sharedValueId(name: string, value: string): string {
  return createHash('sha256').update(`${name}\u0000${value}`).digest('hex').slice(0, 16);
}

/// One service with every chosen literal replaced by its `${NAME}`. Matches on
/// the value as well as the key, so a service edited since the scan keeps its
/// own value rather than being pointed at someone else's.
export function referToShared(spec: ServiceSpec, chosen: readonly SharedValue[]): ServiceSpec {
  const uses = chosen.flatMap((c) =>
    c.uses.filter((u) => u.serviceId === spec.id).map((u) => ({ ...u, name: c.name, value: c.value })),
  );
  if (uses.length === 0) return spec;
  const ref = (name: string) => `\${${name}}`;

  const options = spec.options?.map((option) => {
    const use = uses.find((u) => u.kind === 'option' && u.key === option.key && u.value === option.value);
    return use && option.enabled !== false ? { ...option, value: ref(use.name) } : option;
  });
  const inject = spec.config.inject
    ? Object.fromEntries(
        Object.entries(spec.config.inject).map(([key, value]) => {
          const use = uses.find((u) => u.kind === 'env' && u.key === key && u.value === value);
          return [key, use ? ref(use.name) : value];
        }),
      )
    : undefined;

  return {
    ...spec,
    ...(options ? { options } : {}),
    config: { ...spec.config, ...(inject ? { inject } : {}) },
  };
}

/// A service handed a machine value in the given form, or with the picker's
/// references to it taken away. Adding to a service that already refers to it
/// anywhere — its base included — changes nothing; removing takes only exact
/// references, never a longer value someone wrote or what a base passes down.
export function withMachineValue(
  spec: ServiceSpec,
  name: string,
  on: boolean,
  form: MachineValueForm = { kind: 'env' },
  base?: ServiceSpec,
): ServiceSpec {
  const refs = referencesTo(spec, name, base);
  const ref = `\${${name}}`;
  if (on) {
    if (refs.length > 0) return spec;
    if (form.kind === 'env') {
      return { ...spec, config: { ...spec.config, inject: { ...(spec.config.inject ?? {}), [name]: ref } } };
    }
    const options = [...(spec.options ?? [])];
    const at = options.findIndex((o) => o.key === form.key);
    // A key the service already sets takes the reference in its place, and is
    // switched on: ticking means "start with this".
    if (at >= 0) options[at] = { key: form.key, value: ref };
    else options.push({ key: form.key, value: ref });
    return { ...spec, options };
  }

  const exact = refs.filter((r) => r.exact);
  if (exact.length === 0) return spec;
  const envKeys = new Set(exact.filter((r) => r.kind === 'env').map((r) => r.key));
  const optionKeys = new Set(exact.filter((r) => r.kind === 'option').map((r) => r.key));
  const inject = Object.fromEntries(Object.entries(spec.config.inject ?? {}).filter(([key]) => !envKeys.has(key)));
  return {
    ...spec,
    ...(spec.options
      ? { options: spec.options.filter((o) => !(optionKeys.has(o.key) && o.value === ref && o.enabled !== false)) }
      : {}),
    config: { ...spec.config, inject },
  };
}
