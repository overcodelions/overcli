// Local directory flow registries.
//
// A local registry is just a folder of `*.yaml` flow files — typically a git
// repo the user already owns and pulls themselves. overcli runs no git here:
// it reads the folder, and that's the whole contract. That keeps a private
// registry free of clones, credentials and background fetches.
//
// Two things a remote registry needs are dropped as a result:
//
//   - No index.json. You can't list a directory over https, so a remote
//     registry has to ship a manifest; locally we can just readdir. Nothing
//     to hand-maintain, nothing to drift out of sync with the files.
//   - No declared sha256. That hash guards a file in transit from a server
//     you don't control. This file is already as trusted as the user flows
//     dir it gets installed into, so we hash the body ourselves (to detect
//     edits between listing and install) rather than asking the author for one.
//
// The metadata a remote index would have declared is instead read off the
// flow YAML itself.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as yamlParse } from 'yaml';

import type { FlowRegistryEntry } from '../../shared/types';
import { SLUG_RE } from '../../shared/flows/validation';
import { parseFlowYaml } from '../../shared/flows/yaml';

const YAML_EXT = '.yaml';

export function sha256Of(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf-8').digest('hex');
}

/// Registry-only metadata a flow YAML may carry. None of it is part of `Flow`
/// (the runtime has no use for it), so it's read straight off the raw document
/// instead of going through `parseFlowYaml`.
interface RegistryMeta {
  version?: string;
  tags?: string[];
  author?: { name: string; url?: string };
}

function readMeta(yaml: string): RegistryMeta {
  let doc: unknown;
  try {
    doc = yamlParse(yaml);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== 'object') return {};
  const y = doc as { version?: unknown; tags?: unknown; author?: unknown };

  const tags = Array.isArray(y.tags)
    ? y.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const rawAuthor =
    y.author && typeof y.author === 'object'
      ? (y.author as { name?: unknown; url?: unknown })
      : undefined;

  return {
    // Tolerate `version: 2` as well as `version: "2"` — YAML will have
    // already turned an unquoted number into one.
    version:
      typeof y.version === 'string'
        ? y.version
        : typeof y.version === 'number'
          ? String(y.version)
          : undefined,
    tags: tags.length > 0 ? tags : undefined,
    author:
      rawAuthor && typeof rawAuthor.name === 'string'
        ? {
            name: rawAuthor.name,
            url: typeof rawAuthor.url === 'string' ? rawAuthor.url : undefined,
          }
        : undefined,
  };
}

/// List the installable flows in a local registry directory. Throws if the
/// directory is gone — `browseRegistries` turns that into a per-registry error,
/// which is the signal the user needs when they've moved or renamed the repo.
export function scanLocalRegistry(args: { registryId: string; dir: string }): FlowRegistryEntry[] {
  const entries: FlowRegistryEntry[] = [];
  for (const name of fs.readdirSync(args.dir)) {
    if (!name.endsWith(YAML_EXT)) continue;
    const id = name.slice(0, -YAML_EXT.length);
    // A flow id becomes a filename on install, so a file the slug rule would
    // reject can't be an entry. Skip rather than fail the whole listing: one
    // stray file shouldn't take the registry down.
    if (!SLUG_RE.test(id)) continue;

    const filePath = path.join(args.dir, name);
    let body: string;
    let updatedAt: number;
    try {
      body = fs.readFileSync(filePath, 'utf-8');
      updatedAt = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    const flow = parseFlowYaml({ yaml: body, id, source: 'user', filePath });
    if (!flow) continue;

    const sha256 = sha256Of(body);
    const meta = readMeta(body);
    entries.push({
      registryId: args.registryId,
      id,
      name: flow.name,
      description: flow.description,
      tags: meta.tags,
      author: meta.author,
      // With no `version:` in the YAML, derive one from the content — editing
      // the file then yields a new version instead of silently reusing the old
      // one, so an install always records what was actually installed.
      version: meta.version ?? sha256.slice(0, 12),
      sha256,
      yamlPath: filePath,
      updatedAt,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/// Read the YAML behind a local entry, confirming it's the same bytes the
/// listing was built from.
export function readLocalEntry(
  entry: FlowRegistryEntry,
): { ok: true; body: string } | { ok: false; error: string } {
  if (!entry.yamlPath) return { ok: false, error: 'Local entry has no file path.' };
  let body: string;
  try {
    body = fs.readFileSync(entry.yamlPath, 'utf-8');
  } catch {
    return { ok: false, error: `Could not read ${entry.yamlPath}.` };
  }
  if (sha256Of(body) !== entry.sha256) {
    return {
      ok: false,
      error: `${path.basename(entry.yamlPath)} changed on disk since the library was listed. Refresh and try again.`,
    };
  }
  return { ok: true, body };
}
