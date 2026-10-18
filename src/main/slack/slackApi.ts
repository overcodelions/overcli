// The few Slack Web API calls the bridge makes, over plain `fetch`.
//
// No SDK: five methods, all JSON in and JSON out, and the bridge has to load
// under `overcli serve` with nothing Electron-shaped on its import graph. Every
// call returns a result rather than throwing — the bridge sits on the run
// observer path, and a Slack outage must never take a worker's run down.

export const SLACK_API_BASE = 'https://slack.com/api';

/// Long enough for Slack on a slow day, short enough that a hung request
/// cannot hold the observer's promise chain open.
export const SLACK_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SlackResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function slackCall<T extends object>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<SlackResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `Slack ${method} returned HTTP ${res.status}.` };
    const json = (await res.json()) as { ok?: boolean; error?: string } & T;
    if (!json.ok) return { ok: false, error: `Slack ${method}: ${json.error ?? 'unknown error'}` };
    return { ok: true, data: json };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? `Slack ${method} timed out.` : `Slack ${method}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface SlackIdentity {
  teamId: string;
  team: string;
  botUserId: string;
}

export async function authTest(botToken: string, fetchImpl?: FetchLike): Promise<SlackResult<SlackIdentity>> {
  const res = await slackCall<{ team_id: string; team: string; user_id: string }>('auth.test', botToken, {}, fetchImpl);
  if (!res.ok) return res;
  return { ok: true, data: { teamId: res.data.team_id, team: res.data.team, botUserId: res.data.user_id } };
}

/// A fresh Socket Mode URL. Each is single-use: reconnecting asks again.
export async function openConnection(appToken: string, fetchImpl?: FetchLike): Promise<SlackResult<string>> {
  const res = await slackCall<{ url: string }>('apps.connections.open', appToken, {}, fetchImpl);
  return res.ok ? { ok: true, data: res.data.url } : res;
}

export interface SlackPerson {
  id: string;
  name: string;
  handle: string;
  title?: string;
}

/// Everyone in the workspace who could be invited: real people, not bots,
/// not deactivated. Needs the `users:read` scope. Paged through to the end.
export async function listPeople(botToken: string, fetchImpl?: FetchLike): Promise<SlackResult<SlackPerson[]>> {
  const out: SlackPerson[] = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const res = await slackCall<{
      members: Array<{ id: string; name: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { real_name?: string; display_name?: string; title?: string } }>;
      response_metadata?: { next_cursor?: string };
    }>('users.list', botToken, { limit: 200, ...(cursor ? { cursor } : {}) }, fetchImpl);
    if (!res.ok) return res;
    for (const m of res.data.members) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
      out.push({
        id: m.id,
        name: m.profile?.real_name || m.real_name || m.name,
        handle: m.profile?.display_name || m.name,
        ...(m.profile?.title ? { title: m.profile.title } : {}),
      });
    }
    cursor = res.data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return { ok: true, data: out };
}

/// The Slack member with this email, for company sign-in. Needs the
/// `users:read.email` scope.
export async function lookupByEmail(botToken: string, email: string, fetchImpl?: FetchLike): Promise<SlackResult<{ id: string; name: string }>> {
  // users.lookupByEmail takes form parameters, not JSON.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await (fetchImpl ?? fetch)(`${SLACK_API_BASE}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok?: boolean; error?: string; user?: { id: string; deleted?: boolean; real_name?: string; profile?: { real_name?: string } } };
    if (!json.ok || !json.user || json.user.deleted) return { ok: false, error: `Slack users.lookupByEmail: ${json.error ?? 'not found'}` };
    return { ok: true, data: { id: json.user.id, name: json.user.profile?.real_name || json.user.real_name || email } };
  } catch (err) {
    return { ok: false, error: `Slack users.lookupByEmail: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/// One message, by channel and timestamp — what a reaction was left on.
/// Needs channels:history (groups:history for private channels).
export async function fetchMessage(botToken: string, channel: string, ts: string, fetchImpl?: FetchLike): Promise<SlackResult<{ text: string; user?: string }>> {
  const res = await slackCall<{ messages?: Array<{ text?: string; user?: string }> }>('conversations.history', botToken, { channel, latest: ts, inclusive: true, limit: 1 }, fetchImpl);
  if (!res.ok) return res;
  const m = res.data.messages?.[0];
  return m ? { ok: true, data: { text: m.text ?? '', ...(m.user ? { user: m.user } : {}) } } : { ok: false, error: 'No such message.' };
}

/// The bot's DM channel with a person. Idempotent on Slack's side.
export async function openIm(botToken: string, userId: string, fetchImpl?: FetchLike): Promise<SlackResult<string>> {
  const res = await slackCall<{ channel: { id: string } }>('conversations.open', botToken, { users: userId }, fetchImpl);
  return res.ok ? { ok: true, data: res.data.channel.id } : res;
}

export interface SlackPost {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  /// Post under this name and face instead of the app's — how one bot
  /// speaks as each worker. Needs the `chat:write.customize` scope.
  username?: string;
  iconUrl?: string;
}

export async function postMessage(
  botToken: string,
  post: SlackPost,
  fetchImpl?: FetchLike,
): Promise<SlackResult<{ channel: string; ts: string }>> {
  const res = await slackCall<{ channel: string; ts: string }>(
    'chat.postMessage',
    botToken,
    {
      channel: post.channel,
      text: post.text,
      ...(post.blocks ? { blocks: post.blocks } : {}),
      ...(post.threadTs ? { thread_ts: post.threadTs } : {}),
      ...(post.username ? { username: post.username } : {}),
      ...(post.iconUrl ? { icon_url: post.iconUrl } : {}),
      // A worker's question must read as the question, not as a preview card
      // of whatever link it happened to quote.
      unfurl_links: false,
      unfurl_media: false,
    },
    fetchImpl,
  );
  return res.ok ? { ok: true, data: { channel: res.data.channel, ts: res.data.ts } } : res;
}

export async function updateMessage(
  botToken: string,
  args: { channel: string; ts: string; text: string; blocks?: unknown[] },
  fetchImpl?: FetchLike,
): Promise<SlackResult<object>> {
  return slackCall<object>(
    'chat.update',
    botToken,
    { channel: args.channel, ts: args.ts, text: args.text, blocks: args.blocks ?? [] },
    fetchImpl,
  );
}

/// Slack's mrkdwn treats `&`, `<` and `>` as control characters: `<@U…>` is
/// a mention and `<!channel>` pings everyone. Text from a model or a run must
/// never be able to do either.
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
