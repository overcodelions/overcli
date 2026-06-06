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

  // ---------- CRM & product (stdio / API-key) ----------
  {
    id: 'attio',
    name: 'Attio',
    description: 'Query and update records in Attio, the AI-native CRM.',
    category: 'CRM & product',
    transport: 'stdio',
    targets: ALL_CLIS,
    config: { command: 'npx', args: ['-y', 'attio-mcp-server'] },
    secrets: [
      {
        key: 'ATTIO_API_KEY',
        label: 'Attio API key',
        help: 'Bearer token from Attio → Settings → Developers (or the API Explorer).',
        link: 'https://app.attio.com/settings/developers',
      },
    ],
    docsUrl: 'https://github.com/hmk/attio-mcp-server',
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
      'Run AWS CLI commands and query any AWS service via the official AWS API MCP server. Requires the `uv` toolchain (uvx) on PATH.',
    category: 'Cloud',
    transport: 'stdio',
    targets: ALL_CLIS,
    // AWS Labs servers are Python — run with uvx, not npx. Region carries a
    // default so the server starts; auth comes from the SDK's default
    // credential chain, so we collect no secrets here (see authNote).
    config: { command: 'uvx', args: ['awslabs.aws-api-mcp-server@latest'], env: { AWS_REGION: 'us-east-1' } },
    authNote:
      'No keys to paste — the server uses your machine\'s AWS credentials via the standard SDK chain (env vars, `~/.aws/credentials`/`config`, SSO, or an IAM role). Run `aws configure` or `aws sso login` first.',
    secrets: [
      {
        key: 'AWS_PROFILE',
        label: 'AWS profile (optional)',
        help: 'Leave blank to use your default profile / credential chain. Set it to a named profile from `~/.aws/config` to target a specific account. Not a secret.',
        optional: true,
      },
    ],
    docsUrl: 'https://github.com/awslabs/mcp/tree/main/src/aws-api-mcp-server',
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

function isInstalled(cli: McpCli, id: string): boolean {
  try {
    return readMcpServer(cli, id) !== null;
  } catch {
    return false;
  }
}

export function listMcpCatalog(): McpCatalogItem[] {
  return CATALOG.map((entry) => {
    const installed: Partial<Record<McpCli, boolean>> = {};
    for (const cli of entry.targets) installed[cli] = isInstalled(cli, entry.id);
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
    };
  });
}

/// Build the final config (merging collected secrets into `env`) and
/// fan-write it to the target CLIs via `addMcpServerToTargets`.
export function installMcpCatalogEntry(
  id: string,
  targets: unknown[],
  secrets: Record<string, string> = {},
): AddMcpResult {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Unknown MCP server: ${id}` };

  const config: McpServerConfig = { ...entry.config };

  // Merge collected secret values into the env block, keeping any stub
  // env the template declared. Blank values are dropped so we don't write
  // empty keys the user skipped.
  const baseEnv =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, string>)
      : {};
  const env: Record<string, string> = { ...baseEnv };
  for (const field of entry.secrets ?? []) {
    const value = secrets[field.key];
    if (typeof value === 'string' && value.trim()) env[field.key] = value.trim();
  }
  if (Object.keys(env).length > 0) config.env = env;

  return addMcpServerToTargets({ name: entry.id, config, targets });
}

export function uninstallMcpCatalogEntry(id: string, targets: unknown[]): RemoveMcpResult {
  const entry = CATALOG.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Unknown MCP server: ${id}` };
  return removeMcpServerFromTargets({ name: entry.id, targets });
}
