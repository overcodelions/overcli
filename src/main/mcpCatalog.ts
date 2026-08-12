// Curated MCP server catalog. The MCP analogue of `skillsCatalog.ts`:
// a hardcoded list of popular servers the user can one-click install into
// Claude / Codex / Gemini. Discovery lives here; the actual config writes
// (and the JSON-vs-TOML format split) are delegated to `mcpConfig.ts`.
//
// Two auth shapes:
//   - `stdio`  servers run locally via npx and authenticate with API keys.
//     overcli collects those keys (`secrets`) and writes them into the
//     server's `env` block in each CLI's config.
//   - `remote` servers are hosted; we write the endpoint (`type` + `url`)
//     and the CLI completes the OAuth browser login on first connect.
//     overcli can't perform the handshake itself, hence `authNote`.
//
// v1 is intentionally hardcoded — no remote fetch or signature
// verification. When we outgrow this we move to a fetched index (like the
// flow registry), but the IPC shape stays. Package names / URLs below are
// the best-known-current invocations; users can tweak any of them after
// install via the manual "Add MCP server" form.

import type { McpCatalogItem, McpCli, McpSecretField } from '../shared/types';
import {
  addMcpServerToTargets,
  removeMcpServerFromTargets,
  readMcpServer,
  type AddMcpResult,
  type McpServerConfig,
  type Paths,
  type RemoveMcpResult,
} from './mcpConfig';

const ALL_CLIS: McpCli[] = ['claude', 'codex', 'gemini'];

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: 'stdio' | 'remote';
  targets: McpCli[];
  /// Base config template. For stdio: command/args (+ optional env stub).
  /// For remote: type + url. Collected secrets are merged into `env` at
  /// install time, keyed by each secret's `key`.
  config: McpServerConfig;
  secrets?: McpSecretField[];
  authNote?: string;
  docsUrl?: string;
  /// Recognises an *installed* config that predates the current template —
  /// a server the upstream vendor has since retired or re-shaped. Presence
  /// alone can't tell us this, so entries that have moved carry a matcher
  /// and we surface a reinstall prompt (see `legacyNote`).
  legacy?: (config: McpServerConfig) => boolean;
  /// Why the installed config is stale, shown next to the Reinstall button.
  legacyNote?: string;
}

/// `args` as strings, tolerating the hand-edited configs users can leave
/// behind (missing key, scalar instead of array, numbers in the list).
function asArgs(config: McpServerConfig): string[] {
  const raw = config.args;
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => String(a));
}

const OAUTH_NOTE =
  'Hosted server — overcli writes the endpoint. Claude prompts for OAuth on first use; on Codex, use the "Log in (Codex)" button below (or run `codex mcp login <name>`).';

const CATALOG: CatalogEntry[] = [
  // ---------- Remote / OAuth ----------
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, PRs, code search, and Actions via the official hosted GitHub MCP server.',
    category: 'Dev tools',
    transport: 'remote',
    targets: ALL_CLIS,
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Read and update Linear issues, projects, and cycles.',
    category: 'Productivity',
    transport: 'remote',
    targets: ALL_CLIS,
    config: { type: 'sse', url: 'https://mcp.linear.app/sse' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues and Confluence pages from the hosted Atlassian MCP server.',
    category: 'Productivity',
    transport: 'remote',
    targets: ALL_CLIS,
    // Streamable-HTTP endpoint (not the /v1/sse one): works for Claude's
    // http transport and is required by Codex, which is streamable-HTTP only.
    config: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search and edit Notion pages and databases.',
    category: 'Productivity',
    transport: 'remote',
    targets: ALL_CLIS,
    config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Inspect Sentry issues, events, and stack traces while debugging.',
    category: 'Dev tools',
    transport: 'remote',
    targets: ALL_CLIS,
    config: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },

  // ---------- Design ----------
  {
    id: 'figma-desktop',
    name: 'Figma (Dev Mode)',
    description:
      'Pull frames, layers, variables, and code from your designs via the Dev Mode MCP server built into the Figma desktop app.',
    category: 'Design',
    // http-shaped like the OAuth servers (writes `type` + `url`), but it's a
    // LOCAL server the Figma desktop app hosts on 127.0.0.1:3845 — no OAuth,
    // no API key. The auth handshake the OAUTH_NOTE describes doesn't apply,
    // hence the custom authNote below.
    transport: 'remote',
    // Both Claude and Gemini speak the http transport. Codex is
    // streamable-HTTP only and untested against Figma's endpoint, so it's
    // left out until verified.
    targets: ['claude', 'gemini'],
    config: { type: 'http', url: 'http://127.0.0.1:3845/mcp' },
    authNote:
      'No login or API key. Requires the Figma desktop app running with the Dev Mode MCP server enabled (Figma → Preferences → Enable Dev Mode MCP server). The server listens on 127.0.0.1:3845.',
    docsUrl:
      'https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server',
  },

  // ---------- stdio / API-key ----------
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via the Brave Search API.',
    category: 'Search & web',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    secrets: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API key',
        help: 'Create a key in the Brave Search API dashboard.',
        link: 'https://brave.com/search/api/',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'exa',
    name: 'Exa Search',
    description: 'Neural web search and content retrieval built for AI agents.',
    category: 'Search & web',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', 'exa-mcp-server'] },
    secrets: [
      {
        key: 'EXA_API_KEY',
        label: 'Exa API key',
        help: 'Generate a key from the Exa dashboard.',
        link: 'https://dashboard.exa.ai/api-keys',
      },
    ],
    docsUrl: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Scrape, crawl, and extract structured data from any website.',
    category: 'Search & web',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', 'firecrawl-mcp'] },
    secrets: [
      {
        key: 'FIRECRAWL_API_KEY',
        label: 'Firecrawl API key',
        help: 'Get a key from the Firecrawl dashboard.',
        link: 'https://www.firecrawl.dev/app/api-keys',
      },
    ],
    docsUrl: 'https://github.com/mendableai/firecrawl-mcp-server',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels and post messages in a Slack workspace.',
    category: 'Productivity',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
    secrets: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack bot token',
        help: 'Must be the Bot User OAuth Token (starts with xoxb-) from your app\'s OAuth & Permissions page — NOT an App Configuration Token (xoxe.xoxp-…). Install the app to your workspace first.',
        link: 'https://api.slack.com/apps',
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Slack team ID',
        help: 'Your workspace ID, starts with T (e.g. T02SV3LCY).',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },

  // ---------- CRM & product ----------
  {
    id: 'attio',
    name: 'Attio',
    description: 'Query and update records in Attio, the AI-native CRM.',
    category: 'CRM & product',
    transport: 'remote',
    targets: ALL_CLIS,
    config: { type: 'http', url: 'https://mcp.attio.com/mcp' },
    authNote: OAUTH_NOTE,
    docsUrl: 'https://docs.attio.com/docs/mcp',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Access HubSpot CRM objects — contacts, companies, deals, and tickets.',
    category: 'CRM & product',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@hubspot/mcp-server'] },
    secrets: [
      {
        key: 'PRIVATE_APP_ACCESS_TOKEN',
        label: 'HubSpot private app token',
        help: 'Create a private app in HubSpot with the CRM read scopes you need, then copy its access token.',
        link: 'https://developers.hubspot.com/mcp',
      },
    ],
    docsUrl: 'https://developers.hubspot.com/mcp',
  },

  // ---------- Cloud platforms (stdio) ----------
  {
    id: 'aws',
    name: 'AWS',
    description:
      'Query and operate any AWS service through the AWS-managed MCP endpoint. A thin local proxy signs requests with your own credentials; the tools themselves run AWS-side. Requires the `uv` toolchain (uvx) on PATH.',
    category: 'Cloud',
    transport: 'stdio',
    targets: ALL_CLIS,
    // Replaces the retired `awslabs.aws-api-mcp-server`, which AWS put into
    // end-of-development (see MIGRATION.md linked from docsUrl). Two things
    // the guide is explicit about, both easy to get wrong:
    //   - pin the proxy version; `@latest` is called out as unsupported here
    //   - the default region rides in `--metadata`, NOT `env`. The managed
    //     server reads its region from proxy metadata; an `AWS_REGION` env
    //     var would only steer local credential resolution, so the old
    //     `env: { AWS_REGION }` block silently stops meaning what it meant.
    // `${AWS_REGION}` is substituted from the collected field at install.
    config: {
      command: 'uvx',
      args: [
        'mcp-proxy-for-aws@1.6.3',
        'https://aws-mcp.us-east-1.api.aws/mcp',
        '--metadata',
        'AWS_REGION=${AWS_REGION}',
      ],
    },
    legacy: (config) =>
      asArgs(config).some((a) => a.startsWith('awslabs.aws-api-mcp-server')),
    legacyNote:
      'This is the retired AWS API MCP server — AWS has stopped developing it. Reinstall to switch to the managed AWS MCP endpoint.',
    authNote:
      'No keys to paste — the proxy uses your machine\'s AWS credentials via the standard SDK chain (env vars, `~/.aws/credentials`/`config`, SSO, or an IAM role). Run `aws configure` or `aws sso login` first.',
    secrets: [
      {
        key: 'AWS_REGION',
        label: 'Default region',
        help: 'The region calls target when the agent doesn\'t name one — it can still override per command with `--region`. Not a secret.',
        optional: true,
        defaultValue: 'us-east-1',
      },
      {
        key: 'AWS_PROFILE',
        label: 'AWS profile (optional)',
        help: 'Leave blank to use your default profile / credential chain. Set it to a named profile from `~/.aws/config` to target a specific account. Not a secret.',
        optional: true,
      },
    ],
    docsUrl: 'https://github.com/awslabs/mcp/blob/main/src/aws-api-mcp-server/MIGRATION.md',
  },
  {
    id: 'google-cloud-run',
    name: 'Google Cloud Run',
    description:
      'Deploy, list, and manage Google Cloud Run services and source via the official server. Authenticates with your local gcloud Application Default Credentials — run `gcloud auth application-default login` first.',
    category: 'Cloud',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@google-cloud/cloud-run-mcp'] },
    docsUrl: 'https://github.com/GoogleCloudPlatform/cloud-run-mcp',
  },

  // ---------- stdio / no auth ----------
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scaffold for complex problems.',
    category: 'Utilities',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge-graph memory across conversations.',
    category: 'Utilities',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Drive a headless browser — navigate, click, screenshot, scrape.',
    category: 'Utilities',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
];

function isInstalled(cli: McpCli, id: string, paths?: Paths): boolean {
  try {
    return readMcpServer(cli, id, paths) !== null;
  } catch {
    return false;
  }
}

function isLegacy(cli: McpCli, entry: CatalogEntry, paths?: Paths): boolean {
  if (!entry.legacy) return false;
  try {
    const config = readMcpServer(cli, entry.id, paths);
    return config !== null && entry.legacy(config);
  } catch {
    return false;
  }
}

export function listMcpCatalog(paths?: Paths): McpCatalogItem[] {
  return CATALOG.map((entry) => {
    const installed: Partial<Record<McpCli, boolean>> = {};
    const legacy: Partial<Record<McpCli, boolean>> = {};
    for (const cli of entry.targets) {
      installed[cli] = isInstalled(cli, entry.id, paths);
      legacy[cli] = installed[cli] ? isLegacy(cli, entry, paths) : false;
    }
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      transport: entry.transport,
      targets: entry.targets,
      secrets: entry.secrets ?? [],
      authNote: entry.authNote,
      docsUrl: entry.docsUrl,
      installed,
      legacy,
      legacyNote: entry.legacyNote,
    };
  });
}

/// Build the final config (substituting collected values into `args`,
/// merging the rest into `env`) and fan-write it to the target CLIs via
/// `addMcpServerToTargets`. Reinstalling over an existing entry is how a
/// legacy config gets replaced — the server name is the catalog id, and
/// the writers overwrite that key rather than appending a second server
/// (two AWS servers at once would collide on tool names).
export function installMcpCatalogEntry(
  id: string,
  targets: unknown[],
  secrets: Record<string, string> = {},
  paths?: Paths,
): AddMcpResult {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Unknown MCP server: ${id}` };

  const config: McpServerConfig = { ...entry.config };

  // Resolve each field once: the typed value, else its default, else blank.
  const resolved = new Map<string, string>();
  for (const field of entry.secrets ?? []) {
    const typed = secrets[field.key];
    const value = typeof typed === 'string' && typed.trim() ? typed.trim() : field.defaultValue ?? '';
    if (value) resolved.set(field.key, value);
  }

  // A field the template references as `${KEY}` in `args` belongs on the
  // command line, not in `env` — some servers (AWS) read the two from
  // different places and only honour the arg. Substituting marks the key
  // consumed so it isn't also written as an env var.
  const consumed = new Set<string>();
  const templated = asArgs(config);
  if (templated.length > 0) {
    config.args = templated.map((arg) =>
      arg.replace(/\$\{(\w+)\}/g, (whole, key: string) => {
        if (!resolved.has(key)) return whole;
        consumed.add(key);
        return resolved.get(key)!;
      }),
    );
    // An unfilled placeholder means an optional field was left blank with
    // no default — pass no arg rather than a literal `${KEY}`.
    config.args = dropUnfilledArgs(config.args as string[]);
  }

  // Merge the remaining values into the env block, keeping any stub env
  // the template declared. Blanks are dropped so we don't write empty
  // keys the user skipped.
  const baseEnv =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, string>)
      : {};
  const env: Record<string, string> = { ...baseEnv };
  for (const [key, value] of resolved) {
    if (!consumed.has(key)) env[key] = value;
  }
  if (Object.keys(env).length > 0) config.env = env;

  return paths
    ? addMcpServerToTargets({ name: entry.id, config, targets }, paths)
    : addMcpServerToTargets({ name: entry.id, config, targets });
}

/// Drop args still carrying an unsubstituted `${KEY}`, along with the
/// preceding flag when the placeholder was that flag's value (`--metadata`
/// `AWS_REGION=${AWS_REGION}` → both go). Leaving either behind would ship
/// a literal `${...}` to the server.
function dropUnfilledArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (/\$\{\w+\}/.test(arg)) {
      if (out.length > 0 && out[out.length - 1].startsWith('-')) out.pop();
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function uninstallMcpCatalogEntry(id: string, targets: unknown[]): RemoveMcpResult {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Unknown MCP server: ${id}` };
  return removeMcpServerFromTargets({ name: entry.id, targets });
}
