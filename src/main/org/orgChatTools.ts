// overgo in the app's chats: "Let my chats reach <org>, as me".
//
// For each org server with its switch on (OrgServerEntry.inChats) and a
// sign-in, a chat typed in the app's composer gets one more MCP server —
// `overgo`, or `overgo-<org>` with several (orgServers.ts) — that reaches
// that server's /mcp as the signed-in person. The entry
// returned here holds the org token, so it must only ever be handed to
// `bindRunTools` (runToolRelay.ts): the relay keeps the entry in this process
// and gives the chat a helper command with a per-conversation token instead.
// The org token never reaches a CLI's argv, a config file or the chat's env.
//
// Flow steps and worker runs don't get it: those are local work, and on the
// org server itself nothing sets the source, so its workers never do.

import type { McpServerConfig } from '../mcpConfig';
import { bindRunTools, runToolRelayEnv, setRelayCallGuard } from './runToolRelay';

export const ORG_CHAT_TOOL = 'overgo';
/// Sent on every request, so the server's decision log can say a change came
/// from an overcli chat (controlPlane.ts reads it).
export const ORG_CHAT_CLIENT_HEADER = 'X-Overcli-Client';
export const ORG_CHAT_CLIENT = 'desktop-chat';

/// What chats may do on a server: only read, or read and ask you before
/// each change. There is no "change without asking": a chat that reads a
/// pull request comment or a web page can be talked into a change, and in
/// bypass mode nothing else would stop it.
export type OrgChatAccess = 'read' | 'ask';

export interface OrgChatSource {
  /// The MCP server name chats see: `overgo`, or `overgo-<org>`.
  tool: string;
  serverId?: string;
  /// The org's name, for the question put to the person.
  org?: string;
  /// Absent: 'ask'.
  access?: OrgChatAccess;
  /// Normalized org server address (normalizeOrgUrl), no trailing slash.
  url: string;
  token: string;
}

let source: (() => OrgChatSource[]) | null = null;

/// Where the servers come from: set once by the desktop app. It lists only
/// servers with the switch on and a sign-in.
export function setOrgChatSource(fn: (() => OrgChatSource[] | OrgChatSource | null) | null): void {
  source = fn ? () => [fn()].flat().filter((x): x is OrgChatSource => !!x) : null;
}

/// The org servers' entries for one send, or nothing. Only for chats a
/// person typed into (interactive, not a flow step).
export function orgChatTools(args: { interactive?: boolean; flowStep?: boolean }): Record<string, McpServerConfig> {
  if (!args.interactive || args.flowStep || !source) return {};
  let from: OrgChatSource[] = [];
  try {
    from = source();
  } catch {
    return {};
  }
  const out: Record<string, McpServerConfig> = {};
  for (const s of from) {
    if (!s.url || !s.token) continue;
    handedOut.add(s.tool || ORG_CHAT_TOOL);
    out[s.tool || ORG_CHAT_TOOL] = {
      type: 'http',
      url: `${s.url.replace(/\/+$/, '')}/mcp`,
      headers: { Authorization: `Bearer ${s.token}`, [ORG_CHAT_CLIENT_HEADER]: ORG_CHAT_CLIENT },
    };
  }
  return out;
}

/// A relayed tool as a CLI that starts its own MCP servers (Codex, Gemini)
/// is given it: the relay helper, and the conversation's relay key in its
/// env. The key opens only this conversation's tools on the relay, until
/// the chat closes; the org token stays in this process.
export interface RelayedServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/// `overgo` for a Codex or Gemini chat, bound to the relay. Empty when the
/// chat doesn't get it. Claude chats go through `bindRunTools` with their
/// other tools instead (runner.ts), since the relay keeps one set per chat.
export function orgChatRelayServers(args: { conversationId: string; interactive?: boolean; flowStep?: boolean }): Record<string, RelayedServer> {
  const tools = orgChatTools(args);
  if (!Object.keys(tools).length) return {};
  const bound = bindRunTools(tools, args.conversationId);
  const key = runToolRelayEnv(args.conversationId);
  return Object.fromEntries(
    Object.entries(bound).map(([name, d]) => [
      name,
      {
        command: String(d.command),
        args: Array.isArray(d.args) ? d.args.map(String) : [],
        env: { ...(d.env && typeof d.env === 'object' ? (d.env as Record<string, string>) : {}), ...key },
      },
    ]),
  );
}

/// Every name an org tool has been given this session, so a call on one the
/// source no longer lists (switched off since the chat began) is refused
/// rather than let through as some other tool.
const handedOut = new Set<string>();

/// A change a chat wants to make on an org server, put to the person.
export interface OrgChangeRequest {
  conversationId: string;
  tool: string;
  org: string;
  /// The MCP tool, e.g. `update_worker`.
  name: string;
  args: unknown;
}

/// Put the org tools' calls under the person's say, in the relay, for every
/// backend: reads go through; with 'read' the change tools are hidden and
/// refused; with 'ask' each change waits for `confirm`. Set once by the app.
export function installOrgChatGuard(confirm: ((req: OrgChangeRequest) => Promise<boolean>) | null): void {
  if (!confirm) return setRelayCallGuard(null);
  const current = (tool: string): OrgChatSource | null | undefined => {
    if (!handedOut.has(tool)) return undefined;
    try {
      return source?.().find((s) => (s.tool || ORG_CHAT_TOOL) === tool) ?? null;
    } catch {
      return null;
    }
  };
  setRelayCallGuard({
    listMode: ({ tool }) => {
      const s = current(tool);
      return s === undefined ? null : !s || s.access === 'read' ? 'readOnly' : 'all';
    },
    checkCall: ({ conversationId, tool, name, args }) => {
      const s = current(tool);
      if (s === undefined) return null;
      if (!s) return Promise.resolve({ allow: false, message: `${tool} is turned off for chats now (Settings → Your orgs), so this change wasn't made.` });
      if (s.access === 'read')
        return Promise.resolve({ allow: false, message: `Chats can only read ${s.org ?? tool}. To let a chat make changes, with your OK each time, change it in Settings → Your orgs.` });
      return confirm({ conversationId, tool, org: s.org ?? tool, name, args }).then(
        (yes) => (yes ? { allow: true as const } : { allow: false as const, message: `The person said no to ${name} on ${s.org ?? tool}. Nothing was changed. Ask them what they'd like instead.` }),
        () => ({ allow: false as const, message: `${name} wasn't confirmed, so nothing was changed.` }),
      );
    },
  });
}
