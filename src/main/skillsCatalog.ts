// Tiny built-in "skills marketplace". A handful of curated SKILL.md
// bundles the user can install into ~/.claude/skills/<id>/ and/or
// ~/.codex/skills/<id>/ with one click.
//
// v1 is intentionally hardcoded — no remote fetch, no signature
// verification, no dependencies. The catalog is the source of truth and
// the install just writes a SKILL.md from the embedded body. When we
// outgrow this we'll move to a fetched index, but the IPC shape stays.
//
// Gemini is not a target: gemini-cli has no `skills/` convention to
// write into. The marketplace is Claude + Codex only by design.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MarketplaceSkill, SkillTarget } from '../shared/types';

const HOME = os.homedir();

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  targets: SkillTarget[];
  body: string;
}

const CATALOG: CatalogEntry[] = [
  {
    id: 'git-helper',
    name: 'Git Helper',
    description: 'Conventions for safe git workflows, branch naming, and PR-ready commits.',
    targets: ['claude', 'codex'],
    body: `---
name: git-helper
description: Conventions for safe git workflows, branch naming, and PR-ready commits.
---

# Git Helper

When the user is working with git, follow these conventions.

## Branch naming
- Use \`<author>/<short-topic>\` (e.g. \`alex/fix-login-redirect\`).
- Avoid spaces and capital letters; use hyphens.

## Commits
- Subject in imperative mood, ≤72 chars.
- Body explains the *why*, not the *what* — the diff already shows the what.
- Reference related issues at the bottom (\`Refs #123\`).

## Before pushing
- Run the project's tests if a test command is obvious from package.json / Makefile.
- Don't \`--force\` push to shared branches without confirming with the user.
- Never amend a commit that's already on a remote branch.
`,
  },
  {
    id: 'doc-writer',
    name: 'Doc Writer',
    description: 'Keep README/CHANGELOG entries terse, factual, and reader-first.',
    targets: ['claude', 'codex'],
    body: `---
name: doc-writer
description: Keep README/CHANGELOG entries terse, factual, and reader-first.
---

# Doc Writer

When updating documentation:

- Lead with what the reader needs to do, not what the project is.
- Use active voice and present tense.
- One idea per paragraph; aim for short paragraphs over long ones.
- Code blocks should be runnable as-is — no placeholders unless explicit.
- For CHANGELOG entries, group by **Added / Changed / Fixed / Removed**;
  one bullet per user-visible change with a link to the PR.
`,
  },
  {
    id: 'test-runner',
    name: 'Test Runner',
    description: 'Run the project test command, parse failures, and report concisely.',
    targets: ['claude', 'codex'],
    body: `---
name: test-runner
description: Run the project test command, parse failures, and report concisely.
---

# Test Runner

When asked to run tests:

1. Detect the runner from package.json scripts, Makefile, or pytest/cargo conventions.
2. Run it once, capture full output.
3. Report **only**: passed count, failed count, and the first failing test's error
   line. Don't dump full output unless the user asks.
4. If failures look related to a recent change, propose the most likely culprit
   file:line and stop — let the user decide whether to fix.
`,
  },
  {
    id: 'pr-reviewer',
    name: 'PR Reviewer',
    description: 'Lightweight review checklist focused on correctness and risk.',
    targets: ['claude', 'codex'],
    body: `---
name: pr-reviewer
description: Lightweight review checklist focused on correctness and risk.
---

# PR Reviewer

Reviewing a diff or branch:

## Must catch
- Logic errors that would break the golden path.
- Unhandled error cases that hit production code.
- Security: input validation, secret handling, SQL/command injection.
- Breaking API or schema changes without migration.

## Skip
- Style nits already covered by formatters/linters.
- Naming opinions unless the name is misleading.
- "What if someone someday..." — review the diff, not hypothetical futures.

## Output
- One short paragraph summary.
- A bulleted list of must-fix items, each with file:line and a one-sentence fix.
- An optional "nice to have" section, clearly labeled as non-blocking.
`,
  },
  {
    id: 'image-gen',
    name: 'Image Gen',
    description: 'Generate or edit images for websites, games, and more.',
    targets: ['claude', 'codex'],
    body: `---
name: image-gen
description: Generate or edit images for websites, games, and more.
---

# Image Gen

When the user asks for images:

1. Confirm intent: dimensions, style, transparent background, file format.
2. Use whichever image-generation tool the host CLI exposes. If none is
   wired, scaffold a placeholder asset and describe the prompt that would
   produce it.
3. Save into the project's existing assets directory (look for
   \`assets/\`, \`public/\`, or \`static/\`); never drop files at repo root.
4. Reference the new asset by its relative path in any code/markdown the
   user is editing.
`,
  },
  {
    id: 'plugin-creator',
    name: 'Plugin Creator',
    description: 'Scaffold plugins and marketplace entries.',
    targets: ['claude', 'codex'],
    body: `---
name: plugin-creator
description: Scaffold plugins and marketplace entries.
---

# Plugin Creator

Use when the user wants a new plugin (Claude plugin bundle or Codex
extension).

## Plugin layout
\`\`\`
my-plugin/
  manifest.json      # name, version, description, author
  README.md
  skills/<id>/SKILL.md
  agents/<name>.md
  commands/<name>.md
\`\`\`

## Steps
1. Ask for the plugin id (kebab-case) and a one-line description.
2. Scaffold the directory with a minimal manifest and README.
3. Add at least one skill, agent, or command so the bundle is testable.
4. Print install instructions for the target CLI at the end.
`,
  },
  {
    id: 'skill-creator',
    name: 'Skill Creator',
    description: 'Create or update a skill.',
    targets: ['claude', 'codex'],
    body: `---
name: skill-creator
description: Create or update a skill.
---

# Skill Creator

When the user asks to create or update a skill:

1. Determine the skill id (kebab-case) and a sentence-long description.
2. Skills live at \`<cli>/skills/<id>/SKILL.md\` with this frontmatter:
   \`\`\`
   ---
   name: <id>
   description: <one line>
   ---
   \`\`\`
3. Body sections to consider: **When to use**, **Steps**, **Output
   format**, **Skip**. Keep it tight — skills are read on every relevant
   turn, so brevity matters.
4. Validate the SKILL.md parses (frontmatter + markdown body) before
   handing back.
`,
  },
  {
    id: 'skill-installer',
    name: 'Skill Installer',
    description: 'Install curated skills from openai/skills or other repos.',
    targets: ['claude', 'codex'],
    body: `---
name: skill-installer
description: Install curated skills from openai/skills or other repos.
---

# Skill Installer

When asked to install a third-party skill:

1. Ask for the source: GitHub repo URL or a local path.
2. For GitHub sources, clone or fetch the SKILL.md (and any referenced
   files) without pulling the whole repo unless the user asks.
3. Install into \`~/.claude/skills/<id>/\` for Claude or
   \`~/.codex/skills/<id>/\` for Codex. Mirror to both if the user wants
   cross-backend availability.
4. Confirm by listing the installed path and a one-line summary of what
   the skill does.
`,
  },
  {
    id: 'openai-docs',
    name: 'OpenAI Docs',
    description: 'Reference official OpenAI docs, including upgrade guidance.',
    targets: ['claude', 'codex'],
    body: `---
name: openai-docs
description: Reference official OpenAI docs, including upgrade guidance.
---

# OpenAI Docs

When the user asks about OpenAI APIs, models, or SDK migrations:

- Cite the official docs at \`platform.openai.com/docs\` rather than
  inferring from training data.
- For SDK migrations (e.g. v0 → v1, Chat Completions → Responses API),
  call out breaking changes explicitly: renamed methods, removed
  parameters, response shape differences.
- Prefer the latest stable model id unless the user pins one.
- Note rate-limit and pricing implications when they're relevant to the
  change being made.
`,
  },
  {
    id: 'aspnet-core',
    name: 'Aspnet Core',
    description: '[Windows only] Build and review ASP.NET Core web apps.',
    targets: ['claude', 'codex'],
    body: `---
name: aspnet-core
description: Build and review ASP.NET Core web apps. Best on Windows but works cross-platform with the .NET SDK.
---

# ASP.NET Core

For ASP.NET Core projects:

- Detect the target framework from \`*.csproj\` (\`<TargetFramework>\`).
- Use minimal-API style for new endpoints unless the project already
  uses controllers — match existing conventions.
- Run \`dotnet build\` before reporting work done; surface the first
  warning/error if any.
- For DI, prefer constructor injection; avoid service-locator patterns.
- Don't introduce EF Core migrations without confirming with the user.
`,
  },
  {
    id: 'chatgpt-apps',
    name: 'Chatgpt Apps',
    description: 'Build and scaffold ChatGPT apps.',
    targets: ['claude', 'codex'],
    body: `---
name: chatgpt-apps
description: Build and scaffold ChatGPT apps (custom GPTs, Actions, App SDK).
---

# ChatGPT Apps

When building a ChatGPT App / custom GPT / Action:

1. Define the OpenAPI 3.1 schema for any Action endpoints first — that's
   what ChatGPT introspects.
2. Auth options: none, API key, OAuth. Pick the simplest that works.
3. Keep response payloads small (<10 KB) and structured; ChatGPT
   summarizes them inline.
4. For App SDK projects, scaffold \`app.yaml\` + handler entrypoint and
   wire a local dev runner.
`,
  },
  {
    id: 'cli-creator',
    name: 'CLI Creator',
    description: 'Build CLIs for Codex.',
    targets: ['claude', 'codex'],
    body: `---
name: cli-creator
description: Build command-line tools — argument parsing, subcommands, help text, exit codes.
---

# CLI Creator

When scaffolding a CLI:

1. Pick the right framework: \`commander\` (Node), \`click\` (Python),
   \`clap\` (Rust), \`cobra\` (Go).
2. Subcommand-first design when there will be more than ~3 actions.
3. Help text is a feature: every flag gets a one-line description, every
   subcommand gets a one-line summary plus an example.
4. Exit codes: \`0\` success, \`1\` user error, \`2\` internal error.
5. Respect \`--quiet\` and \`--json\` if any output is parseable.
`,
  },
  {
    id: 'cloudflare-deploy',
    name: 'Cloudflare Deploy',
    description: 'Deploy Workers, Pages, and platform services on Cloudflare.',
    targets: ['claude', 'codex'],
    body: `---
name: cloudflare-deploy
description: Deploy Workers, Pages, and platform services on Cloudflare.
---

# Cloudflare Deploy

For Cloudflare deploys:

- **Workers**: \`wrangler.toml\` is the source of truth. Use
  \`wrangler dev\` locally, \`wrangler deploy\` to ship.
- **Pages**: prefer git-integrated deploys; use \`wrangler pages deploy\`
  for one-shots from CI.
- **Bindings** (KV, R2, D1, Queues, Durable Objects): declare in
  \`wrangler.toml\`; never hardcode IDs in source.
- Secrets via \`wrangler secret put\`, not env vars in the repo.
- Watch for the 1 MB worker size limit and the 50 ms CPU budget on the
  free tier.
`,
  },
  {
    id: 'doc',
    name: 'Doc',
    description: 'Edit and review docx files.',
    targets: ['claude', 'codex'],
    body: `---
name: doc
description: Edit and review .docx files (Word documents).
---

# Doc

When working with .docx files:

- Use \`python-docx\` (Python) or \`docx\` (Node) to read/write — never
  hand-edit the XML.
- Preserve existing styles unless the user asks to restyle.
- For track-changes documents, ask whether to accept/reject before
  editing.
- Output a short diff summary (sections changed, paragraphs added/
  removed) after saving.
`,
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Use Figma MCP for design-to-code work.',
    targets: ['claude', 'codex'],
    body: `---
name: figma
description: Use the Figma MCP server for design-to-code work.
---

# Figma

When the user references a Figma file or frame:

1. Confirm the Figma MCP server is configured (\`figma\` in mcpServers).
2. Resolve the frame: ask for the URL or selection if not provided.
3. Pull node tree and styles; do not invent component names.
4. Map design tokens to the project's existing token system before
   creating new ones.
5. Flag any design that uses pixel values where the codebase uses a
   spacing/typography scale.
`,
  },
  {
    id: 'figma-code-connect-components',
    name: 'Figma Code Connect Components',
    description: 'Map Figma components to code with Code Connect.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-code-connect-components
description: Map Figma components to code with Figma Code Connect.
---

# Figma Code Connect Components

When wiring Code Connect:

- Each component gets a \`<Component>.figma.tsx\` (or .ts/.swift/.kt)
  file describing how Figma props map to code props.
- Use \`figma.connect(MyComponent, '<figma-node-url>', { props: ... })\`.
- Run \`figma connect publish\` after every change so designers see the
  mapping in Figma's dev mode.
- Variants in Figma → discriminated unions or enum props in code.
`,
  },
  {
    id: 'figma-create-design-system-rules',
    name: 'Figma Create Design System Rules',
    description: 'Generate design system rules for your codebase.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-create-design-system-rules
description: Generate design system rules (tokens, spacing, type scale) from a Figma library.
---

# Figma Create Design System Rules

To extract design rules from Figma:

1. Pull color/typography/spacing variables from the linked library.
2. Emit them in the project's existing format (Tailwind config, CSS
   custom properties, JSON tokens — match what's already there).
3. Generate a \`docs/design-system.md\` that lists every token with its
   value and intended use.
4. Flag tokens that are defined in code but not in Figma (and vice
   versa) as drift.
`,
  },
  {
    id: 'figma-create-new-file',
    name: 'Figma Create New File',
    description: 'Create a new blank Figma or FigJam file.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-create-new-file
description: Create a new blank Figma or FigJam file via the Figma API.
---

# Figma Create New File

To create a Figma or FigJam file:

1. Confirm the team id and project id (both required by the API).
2. Ask whether the user wants Design or FigJam.
3. POST to \`/v1/files\` with a name and the chosen type.
4. Return the file URL so the user can open it in the browser.
`,
  },
  {
    id: 'figma-generate-design',
    name: 'Figma Generate Design',
    description: 'Build or update screens from design system components.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-generate-design
description: Build or update Figma screens by composing design-system components.
---

# Figma Generate Design

When asked to generate a Figma design:

1. Pull the linked component library so all instances reference real
   components, not detached frames.
2. Lay out using auto-layout — never absolute pixel positioning.
3. Apply the project's color/spacing/typography tokens; never hardcode
   hex values.
4. Add a frame label and short description so designers can find the
   generated screen.
`,
  },
  {
    id: 'figma-generate-library',
    name: 'Figma Generate Library',
    description: 'Build or update a design system library in Figma.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-generate-library
description: Build or update a design system component library in Figma.
---

# Figma Generate Library

When generating a Figma library:

1. Start from the project's existing tokens (colors, spacing, type).
2. One component per page; variants live inside the component, not as
   sibling frames.
3. Publish as a team library so other files can subscribe.
4. Include a README frame on the cover page documenting versioning and
   contribution rules.
`,
  },
  {
    id: 'figma-implement-design',
    name: 'Figma Implement Design',
    description: 'Turn Figma designs into production-ready code.',
    targets: ['claude', 'codex'],
    body: `---
name: figma-implement-design
description: Turn Figma designs into production-ready code in the project's stack.
---

# Figma Implement Design

When implementing a Figma frame:

1. Detect the project's UI stack (React/Vue/SwiftUI/etc.) and styling
   approach (CSS modules, Tailwind, styled-components).
2. Reuse existing components — only create a new component if no
   existing one matches the Figma component.
3. Token mapping: Figma variables → code tokens. Don't hardcode values
   that exist in the token system.
4. Responsive: respect Figma's auto-layout breakpoints; if the design
   doesn't specify, ask before guessing.
5. Accessibility pass: alt text on images, semantic landmarks, focus
   order.
`,
  },
];

function skillDir(target: SkillTarget, id: string): string {
  const root = target === 'claude' ? '.claude' : '.codex';
  return path.join(HOME, root, 'skills', id);
}

function isInstalled(target: SkillTarget, id: string): boolean {
  return fs.existsSync(path.join(skillDir(target, id), 'SKILL.md'));
}

export function listMarketplaceSkills(): MarketplaceSkill[] {
  return CATALOG.map((entry) => {
    const installed: Partial<Record<SkillTarget, boolean>> = {};
    for (const t of entry.targets) installed[t] = isInstalled(t, entry.id);
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      targets: entry.targets,
      installed,
    };
  });
}

export function installMarketplaceSkill(
  skillId: string,
  targets: SkillTarget[],
): { ok: true } | { ok: false; error: string } {
  const entry = CATALOG.find((e) => e.id === skillId);
  if (!entry) return { ok: false, error: `Unknown skill: ${skillId}` };

  for (const target of targets) {
    if (!entry.targets.includes(target)) {
      return { ok: false, error: `Skill "${skillId}" does not support ${target}` };
    }
    try {
      const dir = skillDir(target, entry.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), entry.body, 'utf-8');
    } catch (err: any) {
      return { ok: false, error: err?.message ?? `Failed to install for ${target}` };
    }
  }
  return { ok: true };
}

export function uninstallMarketplaceSkill(
  skillId: string,
  targets: SkillTarget[],
): { ok: true } | { ok: false; error: string } {
  const entry = CATALOG.find((e) => e.id === skillId);
  if (!entry) return { ok: false, error: `Unknown skill: ${skillId}` };

  for (const target of targets) {
    try {
      const dir = skillDir(target, entry.id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      return { ok: false, error: err?.message ?? `Failed to uninstall for ${target}` };
    }
  }
  return { ok: true };
}

/// Removes a skill directory by path. Accepts either a SKILL.md path or
/// the skill directory itself. Hard-gated to only delete inside
/// ~/.claude/skills/ or ~/.codex/skills/ — refuses anything else.
export function uninstallSkillByPath(
  inputPath: string,
): { ok: true } | { ok: false; error: string } {
  const claudeRoot = path.join(HOME, '.claude', 'skills');
  const codexRoot = path.join(HOME, '.codex', 'skills');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(inputPath);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Path does not exist' };
  }

  const targetDir = stat.isDirectory() ? inputPath : path.dirname(inputPath);
  const parent = path.dirname(targetDir);

  if (parent !== claudeRoot && parent !== codexRoot) {
    return {
      ok: false,
      error: 'Refusing to delete: skill is not directly under ~/.claude/skills or ~/.codex/skills',
    };
  }

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to remove skill directory' };
  }
}
