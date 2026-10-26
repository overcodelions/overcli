// Common MCP servers an admin can install in a click: Setup → Tools opens on
// this list, and picking one fills in the install form. Only the shape of a
// tool lives here — the command or URL and the names of its settings. The
// admin still pastes the values, or signs in on the service's own page.
//
// Remote servers come first where the service runs one: nothing to install
// on the box, and the form works out by itself whether it wants a token or
// a sign-in. A command server is listed when there is no remote one, or
// when the remote one only signs in through a browser and a token is the
// better fit for a server (jira).
//
// The names are what workers list, so they follow what people already call
// the tool on their desktops; a worker that lists one matches as soon as
// it is installed.

import type { ToolTemplate } from './tools';

export type CatalogCategory = 'Code' | 'Work tracking' | 'Docs and chat' | 'Customers and sales' | 'Cloud and data' | 'Web';

export interface CatalogTool extends ToolTemplate {
  title: string;
  /// One line: what a worker can do with it.
  blurb: string;
  category: CatalogCategory;
  /// Where the admin gets the key, or reads how it signs in.
  docs: string;
  /// A line on each setting the form asks for, by name.
  settings?: Record<string, string>;
  /// A remote server that needs no sign-in at all.
  open?: boolean;
  /// For a tool that signs in through a browser: the same tool with a key
  /// instead. The sign-in sends the admin's browser back to the console, and
  /// services refuse a plain http:// address that isn't localhost — which is
  /// what a console inside a private network usually is.
  withToken?: TokenWay;
}

export type TokenWay = Pick<CatalogTool, 'kind' | 'command' | 'args' | 'url' | 'envKeys' | 'headerKeys' | 'docs' | 'settings'>;

const keyCommand = (cmd: string[], envKeys: string[], docs: string, settings?: Record<string, string>): TokenWay => ({
  kind: 'command',
  command: cmd[0],
  args: cmd.slice(1),
  envKeys,
  headerKeys: [],
  docs,
  ...(settings ? { settings } : {}),
});

const remote = (name: string, url: string, rest: Omit<CatalogTool, 'name' | 'kind' | 'url' | 'envKeys' | 'headerKeys'> & { headerKeys?: string[] }): CatalogTool => ({
  name,
  kind: 'http',
  url,
  envKeys: [],
  headerKeys: rest.headerKeys ?? [],
  ...rest,
});

const command = (name: string, cmd: string[], envKeys: string[], rest: Omit<CatalogTool, 'name' | 'kind' | 'command' | 'args' | 'envKeys' | 'headerKeys'>): CatalogTool => ({
  name,
  kind: 'command',
  command: cmd[0],
  args: cmd.slice(1),
  envKeys,
  headerKeys: [],
  ...rest,
});

export const TOOL_CATALOG: CatalogTool[] = [
  remote('github', 'https://api.githubcopilot.com/mcp/', {
    title: 'GitHub',
    blurb: 'Issues, pull requests, code search and Actions runs.',
    category: 'Code',
    docs: 'https://github.com/github/github-mcp-server',
    headerKeys: ['Authorization'],
    settings: { Authorization: 'Bearer and a fine-grained personal access token, ideally a bot account’s' },
  }),
  remote('sentry', 'https://mcp.sentry.dev/mcp', {
    title: 'Sentry',
    blurb: 'Errors, issues and releases, to triage what broke.',
    category: 'Code',
    docs: 'https://docs.sentry.io/product/sentry-mcp/',
    withToken: keyCommand(['npx', '-y', '@sentry/mcp-server@latest'], ['SENTRY_ACCESS_TOKEN', 'SENTRY_HOST'], 'https://github.com/getsentry/sentry-mcp', {
      SENTRY_ACCESS_TOKEN: 'a user auth token with org:read, project:read and event:write',
      SENTRY_HOST: 'only for self-hosted Sentry; leave it out for sentry.io',
    }),
  }),
  remote('vercel', 'https://mcp.vercel.com', {
    title: 'Vercel',
    blurb: 'Projects, deployments and their logs.',
    category: 'Code',
    docs: 'https://vercel.com/docs/mcp/vercel-mcp',
  }),
  remote('context7', 'https://mcp.context7.com/mcp', {
    title: 'Context7',
    blurb: 'Up-to-date docs for the libraries a worker codes against.',
    category: 'Code',
    docs: 'https://github.com/upstash/context7',
    open: true,
  }),
  remote('linear', 'https://mcp.linear.app/mcp', {
    title: 'Linear',
    blurb: 'Issues, projects and cycles.',
    category: 'Work tracking',
    docs: 'https://linear.app/docs/mcp',
    withToken: { kind: 'http', url: 'https://mcp.linear.app/mcp', envKeys: [], headerKeys: ['Authorization'], docs: 'https://linear.app/docs/mcp', settings: { Authorization: 'Bearer and a personal API key from Settings → Security & access' } },
  }),
  remote('atlassian', 'https://mcp.atlassian.com/v2/mcp', {
    title: 'Atlassian Rovo',
    blurb: 'Jira, Confluence, Bitbucket, Loom and Compass through Atlassian’s own server: you sign in once, for the whole org.',
    category: 'Work tracking',
    docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    withToken: keyCommand(['uvx', 'mcp-atlassian'], ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'CONFLUENCE_URL', 'CONFLUENCE_USERNAME', 'CONFLUENCE_API_TOKEN'], 'https://github.com/sooperset/mcp-atlassian', {
      JIRA_URL: 'https://your-site.atlassian.net',
      JIRA_API_TOKEN: 'from id.atlassian.com → Security → API tokens',
      CONFLUENCE_URL: 'https://your-site.atlassian.net/wiki — leave the Confluence lines out to skip it',
    }),
  }),
  command('jira', ['uvx', 'mcp-atlassian'], ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'CONFLUENCE_URL', 'CONFLUENCE_USERNAME', 'CONFLUENCE_API_TOKEN'], {
    title: 'Jira and Confluence (API token)',
    blurb: 'Search, read and update issues and pages with a service account’s token.',
    category: 'Work tracking',
    docs: 'https://github.com/sooperset/mcp-atlassian',
    settings: {
      JIRA_URL: 'https://your-site.atlassian.net',
      JIRA_API_TOKEN: 'from id.atlassian.com → Security → API tokens',
      CONFLUENCE_URL: 'https://your-site.atlassian.net/wiki — leave the Confluence lines out to skip it',
    },
  }),
  command('bitbucket', ['npx', '-y', '@aashari/mcp-server-atlassian-bitbucket'], ['ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN'], {
    title: 'Bitbucket',
    blurb: 'Repositories, pull requests, comments and diffs on Bitbucket Cloud, with an API token. Atlassian Rovo covers Bitbucket too, with a sign-in.',
    category: 'Code',
    docs: 'https://github.com/aashari/mcp-server-atlassian-bitbucket',
    settings: { ATLASSIAN_API_TOKEN: 'an Atlassian API token with Bitbucket scopes, from id.atlassian.com → Security → API tokens' },
  }),
  remote('notion', 'https://mcp.notion.com/mcp', {
    title: 'Notion',
    blurb: 'Search, read and write pages and databases.',
    category: 'Docs and chat',
    docs: 'https://developers.notion.com/docs/mcp',
    withToken: keyCommand(['npx', '-y', '@notionhq/notion-mcp-server'], ['NOTION_TOKEN'], 'https://github.com/makenotion/notion-mcp-server', {
      NOTION_TOKEN: 'ntn_… from an internal integration; share the pages it may see with it',
    }),
  }),
  remote('attio', 'https://mcp.attio.com/mcp', {
    title: 'Attio',
    blurb: 'CRM records, lists, notes and tasks.',
    category: 'Customers and sales',
    docs: 'https://docs.attio.com/mcp/overview',
    withToken: keyCommand(['npx', '-y', 'attio-mcp'], ['ATTIO_API_KEY'], 'https://github.com/kesslerio/attio-mcp-server', {
      ATTIO_API_KEY: 'from Workspace settings → Developers → access tokens',
    }),
  }),
  command('salesforce', ['npx', '-y', '@tsmztech/mcp-server-salesforce'], ['SALESFORCE_CONNECTION_TYPE', 'SALESFORCE_INSTANCE_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'], {
    title: 'Salesforce',
    blurb: 'Query, read and update records and objects with SOQL.',
    category: 'Customers and sales',
    docs: 'https://github.com/tsmztech/mcp-server-salesforce',
    settings: {
      SALESFORCE_CONNECTION_TYPE: 'OAuth_2.0_Client_Credentials — a connected app that runs as an integration user',
      SALESFORCE_INSTANCE_URL: 'https://your-org.my.salesforce.com',
      SALESFORCE_CLIENT_ID: 'the connected app’s consumer key',
    },
  }),
  command('hubspot', ['npx', '-y', '@hubspot/mcp-server'], ['PRIVATE_APP_ACCESS_TOKEN'], {
    title: 'HubSpot',
    blurb: 'Contacts, companies, deals, tickets and their notes.',
    category: 'Customers and sales',
    docs: 'https://developers.hubspot.com/mcp',
    settings: { PRIVATE_APP_ACCESS_TOKEN: 'pat-… from a private app (Settings → Integrations → Private apps) with the CRM scopes workers need' },
  }),
  command('zendesk', ['npx', '-y', 'zd-mcp-server@0.6.1'], ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_TOKEN'], {
    // Zendesk's own MCP server doesn't read tickets yet: this one is a
    // community server.
    title: 'Zendesk',
    blurb: 'Support tickets: search them, read the thread, comment and update. A community server, not Zendesk’s own.',
    category: 'Customers and sales',
    docs: 'https://github.com/koundinya/zd-mcp-server',
    settings: {
      ZENDESK_SUBDOMAIN: 'The part before .zendesk.com in your Zendesk address',
      ZENDESK_EMAIL: 'The email of the Zendesk user the token belongs to',
      ZENDESK_TOKEN: 'An API token (Admin Center → Apps and integrations → Zendesk API)',
    },
  }),
  // Productboard's own server, signed in with a Productboard login; a
  // community server takes an API token where that sign-in can't reach.
  remote('productboard', 'https://mcp.productboard.com', {
    title: 'Productboard',
    blurb: 'Features, notes and insights, specs and documents: read and update them.',
    category: 'Work tracking',
    docs: 'https://productboard.com/integrations/mcp-server',
    withToken: keyCommand(['npx', '-y', '@tomgutt/productboard-mcp@2.0.0'], ['PRODUCTBOARD_ACCESS_TOKEN'], 'https://github.com/tomgutt/tg-productboard-mcp', {
      PRODUCTBOARD_ACCESS_TOKEN: 'A public API access token (Productboard → Integrations → Public API). This is a community server, not Productboard’s own.',
    }),
  }),
  // The same workspace through Productboard's public API with a token, as
  // its own tool: Productboard's server only signs people in, and a token
  // belongs to no one's login, which suits workers running on their own.
  // Productboard has retired API v1 for workspaces moved to v2, and the
  // first community server (productboard-mcp) only speaks v1: this one
  // speaks v2. Pinned to the version read through: a community package
  // runs with the org's token, and a newer one could do anything with it.
  command('productboard-api', ['npx', '-y', '@tomgutt/productboard-mcp@2.0.0'], ['PRODUCTBOARD_ACCESS_TOKEN'], {
    title: 'Productboard (API token)',
    blurb: 'Features, notes, companies and releases through the public API v2, with a token. A community server, not Productboard’s own.',
    category: 'Work tracking',
    docs: 'https://github.com/tomgutt/tg-productboard-mcp',
    settings: { PRODUCTBOARD_ACCESS_TOKEN: 'A public API access token (Productboard → Integrations → Public API), made by a Productboard admin' },
  }),
  remote('intercom', 'https://mcp.intercom.com/mcp', {
    title: 'Intercom',
    blurb: 'Conversations and contacts, to answer and route support.',
    category: 'Customers and sales',
    docs: 'https://developers.intercom.com/docs/guides/mcp',
    withToken: { kind: 'http', url: 'https://mcp.intercom.com/mcp', envKeys: [], headerKeys: ['Authorization'], docs: 'https://developers.intercom.com/docs/guides/mcp', settings: { Authorization: 'Bearer and an access token from a Developer Hub app' } },
  }),
  remote('stripe', 'https://mcp.stripe.com', {
    title: 'Stripe',
    blurb: 'Customers, payments, invoices and subscriptions.',
    category: 'Customers and sales',
    docs: 'https://docs.stripe.com/mcp',
    headerKeys: ['Authorization'],
    settings: { Authorization: 'Bearer and a restricted key (rk_…) with only what workers need' },
  }),
  command('slack', ['npx', '-y', '@modelcontextprotocol/server-slack'], ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'], {
    title: 'Slack',
    blurb: 'Read channels and threads, post and reply as a bot.',
    category: 'Docs and chat',
    docs: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack',
    settings: { SLACK_BOT_TOKEN: 'xoxb-… from a Slack app installed to the workspace', SLACK_TEAM_ID: 'T… — the workspace ID' },
  }),
  remote('supabase', 'https://mcp.supabase.com/mcp', {
    title: 'Supabase',
    blurb: 'Tables, SQL, logs and edge functions.',
    category: 'Cloud and data',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    withToken: keyCommand(['npx', '-y', '@supabase/mcp-server-supabase@latest', '--read-only'], ['SUPABASE_ACCESS_TOKEN'], 'https://github.com/supabase-community/supabase-mcp', {
      SUPABASE_ACCESS_TOKEN: 'a personal access token from Account → Access tokens; add --project-ref=<ref> to the command to keep it to one project',
    }),
  }),
  command('aws', ['uvx', 'awslabs.aws-api-mcp-server@latest'], ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], {
    title: 'AWS',
    blurb: 'Any AWS CLI call, with the rights of the keys you give it.',
    category: 'Cloud and data',
    docs: 'https://github.com/awslabs/mcp/tree/main/src/aws-api-mcp-server',
    settings: { AWS_ACCESS_KEY_ID: 'an IAM user or role with only the rights workers need' },
  }),
  command('mongodb', ['npx', '-y', 'mongodb-mcp-server'], ['MDB_MCP_CONNECTION_STRING'], {
    title: 'MongoDB',
    blurb: 'Query collections and inspect schemas.',
    category: 'Cloud and data',
    docs: 'https://github.com/mongodb-js/mongodb-mcp-server',
    settings: { MDB_MCP_CONNECTION_STRING: 'mongodb+srv://… — a read-only user is safest' },
  }),
  command('playwright', ['npx', '-y', '@playwright/mcp@latest', '--headless'], [], {
    title: 'Playwright',
    blurb: 'A headless browser: open pages, click, fill forms, take screenshots.',
    category: 'Web',
    docs: 'https://github.com/microsoft/playwright-mcp',
  }),
  command('puppeteer', ['npx', '-y', '@modelcontextprotocol/server-puppeteer'], [], {
    title: 'Puppeteer',
    blurb: 'A Chrome browser to open pages, click, fill forms and take screenshots.',
    category: 'Web',
    docs: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer',
  }),
  command('fetch', ['uvx', 'mcp-server-fetch'], [], {
    title: 'Fetch',
    blurb: 'Read any web page as text.',
    category: 'Web',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  }),
  command('brave-search', ['npx', '-y', '@brave/brave-search-mcp-server'], ['BRAVE_API_KEY'], {
    title: 'Brave Search',
    blurb: 'Web and news search.',
    category: 'Web',
    docs: 'https://github.com/brave/brave-search-mcp-server',
    settings: { BRAVE_API_KEY: 'from api-dashboard.search.brave.com' },
  }),
];

/// The catalog entry for a name a worker lists, so a tool a worker needs
/// can be filled in even when nobody published how it was set up.
export function catalogFor(name: string): CatalogTool | undefined {
  const n = name.toLowerCase();
  return TOOL_CATALOG.find((t) => t.name === n);
}

/// A connector on someone's Claude account, as a worker built on their
/// desktop lists it: "claude.ai Atlassian", or Claude's tool-name form
/// claude_ai_Atlassian. It lives on that person's account, so a server never
/// has it; the server needs its own install, under a name like any tool's.
const CONNECTOR = /^claude[._ ]ai[ _]+(.+)$/i;

export function connectorTitle(name: string): string | undefined {
  const m = CONNECTOR.exec(name.trim());
  return m ? m[1].replace(/_/g, ' ').trim() : undefined;
}

/// The tool name a connector is installed under on the server: the catalog's
/// when it knows the service, else the connector's own name, slugged.
export function connectorTool(name: string): string | undefined {
  const title = connectorTitle(name);
  if (!title) return undefined;
  const t = title.toLowerCase();
  const slug = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const known = TOOL_CATALOG.find((c) => c.name === slug || c.title.toLowerCase() === t || c.title.toLowerCase().startsWith(`${t} `));
  return known?.name ?? (slug ? slug.slice(0, 64) : undefined);
}
