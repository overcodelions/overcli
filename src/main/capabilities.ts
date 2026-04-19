// Filesystem scanner that discovers CLI "capabilities" — skills,
// subagents, slash commands, plugins, MCP servers — across every CLI we
// support. Runs at app start so the Extensions sheet is populated before
// the user has sent a first message (unlike SystemInitInfo.slashCommands
// which only arrives after the CLI's init block).
//
// Structure per CLI:
//
//   ~/.claude/
//     agents/*.md                    — user subagents
//     skills/*/SKILL.md              — user skills
//     commands/*.md                  — user slash commands
//     plugins/installed_plugins.json — plugin manifest
//     plugins/cache/<ns>/<name>/<ver>/{skills,agents,commands}/ — plugin contents
//     settings.json                  — mcpServers config
//
//   ~/.codex/
//     skills/*/                      — codex skills (weaker convention)
//     config.toml                    — mcp_servers config
//
//   ~/.gemini/
//     settings.json                  — mcp server config
//
// MCP servers are merged across CLIs by name so the UI can show which
// CLIs a given server is configured for.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  Backend,
  CapabilitiesReport,
  CapabilityEntry,
  CapabilityKind,
  CapabilitySource,
} from '../shared/types';

const HOME = os.homedir();

export function scanCapabilities(): CapabilitiesReport {
  const entries: CapabilityEntry[] = [];
  const warnings: string[] = [];

  runScanner('claude-user', () => entries.push(...scanClaudeUser()), warnings);
  runScanner('claude-plugins', () => entries.push(...scanClaudePlugins()), warnings);
  runScanner('codex-user', () => entries.push(...scanCodexUser()), warnings);

  const mcp = scanMcpAcrossClis(warnings);
  entries.push(...mcp);

  return {
    generatedAt: Date.now(),
    entries,
    warnings,
  };
}

function runScanner(label: string, fn: () => void, warnings: string[]) {
  try {
    fn();
  } catch (err: any) {
    warnings.push(`${label}: ${err?.message ?? String(err)}`);
  }
}

// ---------- Claude user-level directories ----------

function scanClaudeUser(): CapabilityEntry[] {
  const out: CapabilityEntry[] = [];
  const base = path.join(HOME, '.claude');

  for (const entry of listMarkdown(path.join(base, 'agents'))) {
    out.push(markdownCapability(entry, 'agent', 'user', ['claude']));
  }
  for (const entry of listMarkdown(path.join(base, 'commands'))) {
    out.push(markdownCapability(entry, 'command', 'user', ['claude']));
  }
  for (const skill of listSkillDirs(path.join(base, 'skills'))) {
    out.push(skillCapability(skill, 'user', ['claude']));
  }

  return out;
}

// ---------- Claude plugins ----------

interface ClaudeInstalledPlugins {
  plugins?: Record<string, Array<{ installPath: string; version?: string }>>;
}

function scanClaudePlugins(): CapabilityEntry[] {
  const out: CapabilityEntry[] = [];
  const manifest = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(manifest)) return out;

  const raw = fs.readFileSync(manifest, 'utf-8');
  const parsed: ClaudeInstalledPlugins = JSON.parse(raw);
  const plugins = parsed.plugins ?? {};

  for (const [fullId, installs] of Object.entries(plugins)) {
    for (const install of installs) {
      if (!install?.installPath) continue;
      if (!fs.existsSync(install.installPath)) continue;

      const pluginId = pluginShortName(fullId);

      // Plugin bundle itself.
      out.push({
        kind: 'plugin',
        id: `plugin:${fullId}`,
        name: pluginId,
        description: install.version ? `version ${install.version}` : undefined,
        source: 'plugin',
        pluginId: fullId,
        path: install.installPath,
        clis: ['claude'],
      });

      const skillsDir = path.join(install.installPath, 'skills');
      for (const skill of listSkillDirs(skillsDir)) {
        out.push(skillCapability(skill, 'plugin', ['claude'], fullId));
      }

      const agentsDir = path.join(install.installPath, 'agents');
      for (const entry of listMarkdown(agentsDir)) {
        out.push(markdownCapability(entry, 'agent', 'plugin', ['claude'], fullId));
      }

      const commandsDir = path.join(install.installPath, 'commands');
      for (const entry of listMarkdown(commandsDir)) {
        out.push(markdownCapability(entry, 'command', 'plugin', ['claude'], fullId));
      }
    }
  }

  return out;
}

function pluginShortName(fullId: string): string {
  const at = fullId.indexOf('@');
  return at > 0 ? fullId.slice(0, at) : fullId;
}

// ---------- Codex user-level directories ----------

function scanCodexUser(): CapabilityEntry[] {
  const out: CapabilityEntry[] = [];
  const skillsBase = path.join(HOME, '.codex', 'skills');
  if (!fs.existsSync(skillsBase)) return out;

  // Codex's skill convention is looser — subdirectories may or may not
  // contain a SKILL.md. Treat each first-level dir as a skill and use
  // the folder name as the identifier.
  for (const dirent of readdirSafe(skillsBase)) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(skillsBase, dirent.name);
    const skillMd = path.join(dir, 'SKILL.md');
    const meta = fs.existsSync(skillMd) ? parseFrontmatter(skillMd) : {};
    out.push({
      kind: 'skill',
      id: `skill:codex:${dirent.name}`,
      name: meta.name ?? dirent.name,
      description: meta.description,
      source: 'user',
      path: fs.existsSync(skillMd) ? skillMd : dir,
      clis: ['codex'],
    });
  }

  return out;
}

// ---------- MCP across every CLI ----------

interface McpHit {
  name: string;
  cli: Backend;
  path: string;
  description?: string;
}

function scanMcpAcrossClis(warnings: string[]): CapabilityEntry[] {
  const hits: McpHit[] = [];

  runScanner('claude-mcp', () => hits.push(...scanClaudeMcp()), warnings);
  runScanner('codex-mcp', () => hits.push(...scanCodexMcp()), warnings);
  runScanner('gemini-mcp', () => hits.push(...scanGeminiMcp()), warnings);

  // Merge by server name so one row per server lists the CLIs it's
  // configured for.
  const byName = new Map<string, { entry: CapabilityEntry; seen: Set<Backend> }>();
  for (const hit of hits) {
    const key = hit.name;
    const existing = byName.get(key);
    if (existing) {
      if (!existing.seen.has(hit.cli)) {
        existing.seen.add(hit.cli);
        existing.entry.clis.push(hit.cli);
      }
      continue;
    }
    byName.set(key, {
      seen: new Set([hit.cli]),
      entry: {
        kind: 'mcp',
        id: `mcp:${hit.name}`,
        name: hit.name,
        description: hit.description,
        source: 'user',
        path: hit.path,
        clis: [hit.cli],
      },
    });
  }

  return [...byName.values()].map((v) => v.entry);
}

function scanClaudeMcp(): McpHit[] {
  const out: McpHit[] = [];
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return out;
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  const servers = parsed?.mcpServers ?? {};
  for (const name of Object.keys(servers)) {
    out.push({ name, cli: 'claude', path: settingsPath });
  }
  return out;
}

function scanCodexMcp(): McpHit[] {
  const out: McpHit[] = [];
  const cfgPath = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(cfgPath)) return out;
  const text = fs.readFileSync(cfgPath, 'utf-8');
  // Lightweight TOML parse: we only care about `[mcp_servers.<name>]`
  // section headers. Avoids pulling in a full TOML dependency.
  const re = /^\s*\[\s*mcp_servers\.([A-Za-z0-9._-]+)\s*\]/gm;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text))) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, cli: 'codex', path: cfgPath });
  }
  return out;
}

function scanGeminiMcp(): McpHit[] {
  const out: McpHit[] = [];
  const settingsPath = path.join(HOME, '.gemini', 'settings.json');
  if (!fs.existsSync(settingsPath)) return out;
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  // Gemini's settings file uses `mcpServers` by current convention; tolerate
  // the snake-case variant some community configs ship with.
  const servers = parsed?.mcpServers ?? parsed?.mcp_servers ?? {};
  for (const name of Object.keys(servers)) {
    out.push({ name, cli: 'gemini', path: settingsPath });
  }
  return out;
}

// ---------- Helpers ----------

interface MarkdownFile {
  name: string;
  path: string;
  frontmatter: Record<string, string>;
}

function listMarkdown(dir: string): MarkdownFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: MarkdownFile[] = [];
  for (const dirent of readdirSafe(dir)) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.toLowerCase().endsWith('.md')) continue;
    const full = path.join(dir, dirent.name);
    out.push({
      name: dirent.name.replace(/\.md$/i, ''),
      path: full,
      frontmatter: parseFrontmatter(full),
    });
  }
  return out;
}

interface SkillDir {
  name: string;
  path: string;
  frontmatter: Record<string, string>;
}

function listSkillDirs(root: string): SkillDir[] {
  if (!fs.existsSync(root)) return [];
  const out: SkillDir[] = [];
  for (const dirent of readdirSafe(root)) {
    if (!dirent.isDirectory()) continue;
    const skillMd = path.join(root, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    out.push({
      name: dirent.name,
      path: skillMd,
      frontmatter: parseFrontmatter(skillMd),
    });
  }
  return out;
}

function markdownCapability(
  entry: MarkdownFile,
  kind: CapabilityKind,
  source: CapabilitySource,
  clis: Backend[],
  pluginId?: string,
): CapabilityEntry {
  const fmName = entry.frontmatter.name ?? entry.name;
  return {
    kind,
    id: idFor(kind, pluginId, fmName),
    name: fmName,
    description: entry.frontmatter.description,
    source,
    pluginId,
    path: entry.path,
    clis: [...clis],
  };
}

function skillCapability(
  skill: SkillDir,
  source: CapabilitySource,
  clis: Backend[],
  pluginId?: string,
): CapabilityEntry {
  const fmName = skill.frontmatter.name ?? skill.name;
  return {
    kind: 'skill',
    id: idFor('skill', pluginId, fmName),
    name: fmName,
    description: skill.frontmatter.description,
    source,
    pluginId,
    path: skill.path,
    clis: [...clis],
  };
}

function idFor(kind: CapabilityKind, pluginId: string | undefined, name: string): string {
  const ns = pluginId ? pluginShortName(pluginId) : 'user';
  return `${kind}:${ns}:${name}`;
}

function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/// Minimal YAML frontmatter parser. Handles the subset every SKILL.md /
/// agent / command file uses: top-level `key: value` pairs, optional
/// double or single quotes around the value. Multi-line values and
/// nested maps are not supported — nothing in the wild uses them here.
function parseFrontmatter(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }
  if (!text.startsWith('---')) return result;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return result;
  const block = text.slice(3, end).trim();
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
