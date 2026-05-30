import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';

import { Store } from '../store';
import type { FlowRegistry, FlowRegistryEntry, InstalledRegistryFlow } from '../../shared/types';
import { SLUG_RE } from '../../shared/flows/validation';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { getAuthHeader } from './registryAuth';

const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'flows-registry-cache');
}
function cacheFile(registryId: string): string {
  return path.join(cacheDir(), `${registryId}.json`);
}
function userFlowsDir(): string {
  return path.join(app.getPath('userData'), 'flows');
}

interface RawIndex {
  flows?: Array<{
    id?: string; name?: string; description?: string;
    tags?: string[]; author?: { name?: string; url?: string };
    version?: string; sha256?: string; yaml_url?: string;
  }>;
}

function authHeadersFor(registryId: string): Record<string, string> {
  const h = getAuthHeader(registryId);
  return h ? { Authorization: h } : {};
}

function resolveYamlUrl(indexUrl: string, yamlUrl: string): string {
  if (/^https?:\/\//.test(yamlUrl)) return yamlUrl;
  return new URL(yamlUrl, indexUrl).toString();
}

export async function fetchRegistry(
  registry: FlowRegistry,
  opts: { force?: boolean } = {},
): Promise<FlowRegistryEntry[]> {
  const file = cacheFile(registry.id);
  if (!opts.force && fs.existsSync(file)) {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return cached.entries as FlowRegistryEntry[];
    }
  }
  const res = await fetch(registry.indexUrl, { headers: authHeadersFor(registry.id) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${registry.indexUrl}`);
  const raw = (await res.json()) as RawIndex;
  const entries: FlowRegistryEntry[] = (raw.flows ?? [])
    .filter((e) => e.id && SLUG_RE.test(e.id) && e.version && e.sha256 && e.yaml_url)
    .map((e) => ({
      registryId: registry.id,
      id: e.id as string,
      name: e.name ?? (e.id as string),
      description: e.description,
      tags: e.tags,
      author: e.author as FlowRegistryEntry['author'],
      version: e.version as string,
      sha256: e.sha256 as string,
      yamlUrl: resolveYamlUrl(registry.indexUrl, e.yaml_url as string),
    }));
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(cacheFile(registry.id), JSON.stringify({ entries }), 'utf-8');
  return entries;
}

export async function browseRegistries(args: { registryId?: string; force?: boolean }) {
  const settings = Store.load().settings;
  const registries = settings.flowRegistries ?? [];
  const targets = args.registryId ? registries.filter((r) => r.id === args.registryId) : registries;
  const out: FlowRegistryEntry[] = [];
  const errors: Array<{ registryId: string; error: string }> = [];
  await Promise.all(targets.map(async (r) => {
    try { out.push(...await fetchRegistry(r, { force: args.force })); }
    catch (e) { errors.push({ registryId: r.id, error: e instanceof Error ? e.message : String(e) }); }
  }));
  return { ok: true as const, entries: out, errors };
}

export async function installFromRegistry(args: { registryId: string; id: string; version: string }) {
  if (!SLUG_RE.test(args.registryId)) return { ok: false as const, error: 'Invalid registryId.' };
  if (!SLUG_RE.test(args.id)) return { ok: false as const, error: 'Invalid flow id.' };
  const settings = Store.load().settings;
  const registry = (settings.flowRegistries ?? []).find((r) => r.id === args.registryId);
  if (!registry) return { ok: false as const, error: `Unknown registry "${args.registryId}".` };
  const entries = await fetchRegistry(registry, { force: false });
  const entry = entries.find((e) => e.id === args.id && e.version === args.version);
  if (!entry) return { ok: false as const, error: `Entry ${args.id}@${args.version} not in registry.` };
  const res = await fetch(entry.yamlUrl, { headers: authHeadersFor(registry.id) });
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status} fetching YAML.` };
  const body = await res.text();
  const sha = crypto.createHash('sha256').update(body, 'utf-8').digest('hex');
  if (sha !== entry.sha256.toLowerCase()) {
    return { ok: false as const, error: `SHA256 mismatch (expected ${entry.sha256}, got ${sha}).` };
  }
  const filename = `installed-${registry.id}-${entry.id}.yaml`;
  const filePath = path.join(userFlowsDir(), filename);
  const flow = parseFlowYaml({ yaml: body, id: filename.slice(0, -5), source: 'user', filePath });
  if (!flow) return { ok: false as const, error: 'YAML failed to parse.' };
  const v = validateFlow(flow);
  if (!v.ok) return { ok: false as const, error: `Validation failed: ${v.errors.map((x) => x.message).join('; ')}` };
  fs.mkdirSync(userFlowsDir(), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, filePath);
  const installed: InstalledRegistryFlow = { registryId: registry.id, id: entry.id, version: entry.version, filename };
  const list = (settings.installedRegistryFlows ?? []).filter(
    (i) => !(i.registryId === installed.registryId && i.id === installed.id),
  );
  list.push(installed);
  Store.saveSettings({ ...settings, installedRegistryFlows: list });
  return { ok: true as const, filePath };
}

export function upsertRegistry(args: { registry: FlowRegistry; authHeader?: string | null }) {
  if (!SLUG_RE.test(args.registry.id)) return { ok: false as const, error: 'Invalid registry id.' };
  if (!/^https?:\/\//.test(args.registry.indexUrl)) return { ok: false as const, error: 'indexUrl must be http(s).' };
  const settings = Store.load().settings;
  const list = (settings.flowRegistries ?? []).filter((r) => r.id !== args.registry.id);
  list.push(args.registry);
  Store.saveSettings({ ...settings, flowRegistries: list });
  if (args.authHeader !== undefined) {
    require('./registryAuth').setAuthHeader(args.registry.id, args.authHeader);
  }
  return { ok: true as const };
}

export function removeRegistry(args: { registryId: string }) {
  if (args.registryId === 'official') return { ok: false as const, error: 'Cannot remove the default registry.' };
  const settings = Store.load().settings;
  const list = (settings.flowRegistries ?? []).filter((r) => r.id !== args.registryId);
  Store.saveSettings({ ...settings, flowRegistries: list });
  require('./registryAuth').removeAuthHeader(args.registryId);
  return { ok: true as const };
}

export function listRegistries(): FlowRegistry[] {
  return Store.load().settings.flowRegistries ?? [];
}
