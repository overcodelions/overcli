// Where the Slack bridge's tokens and switch come from.
//
// Two tokens, because Socket Mode needs two: the bot token (`xoxb-`) posts and
// reads as the app; the app-level token (`xapp-`, scope `connections:write`)
// opens the websocket. Both are credentials, so both live in `host().secrets`
// — and, like the webhook token, each has its own env var for `overcli serve`,
// whose secrets are read-only and env-backed. The env var wins when both exist.

import { host } from '../host';
import { log } from '../diagnostics';
import { Store } from '../store';

export const SLACK_BOT_TOKEN_KEY = 'slack-bot-token';
export const SLACK_APP_TOKEN_KEY = 'slack-app-token';
export const SLACK_BOT_TOKEN_ENV = 'OVERCLI_SLACK_BOT_TOKEN';
export const SLACK_APP_TOKEN_ENV = 'OVERCLI_SLACK_APP_TOKEN';
/// Headless switch: a daemon has no settings screen.
export const SLACK_ENABLED_ENV = 'OVERCLI_SLACK_ENABLED';

export type SlackTokenKind = 'bot' | 'app';

const KEY: Record<SlackTokenKind, string> = { bot: SLACK_BOT_TOKEN_KEY, app: SLACK_APP_TOKEN_KEY };
const ENV: Record<SlackTokenKind, string> = { bot: SLACK_BOT_TOKEN_ENV, app: SLACK_APP_TOKEN_ENV };
const PREFIX: Record<SlackTokenKind, string> = { bot: 'xoxb-', app: 'xapp-' };

export function slackTokenFromEnv(kind: SlackTokenKind): boolean {
  return !!process.env[ENV[kind]]?.trim();
}

/// The token, or null. Never throws: a locked keychain must leave the bridge
/// off, not crash startup.
export function configuredSlackToken(kind: SlackTokenKind): string | null {
  try {
    const fromEnv = process.env[ENV[kind]]?.trim();
    if (fromEnv) return fromEnv;
    return host().secrets.get(KEY[kind])?.trim() || null;
  } catch (err) {
    log('warn', 'slack', `Could not read the Slack ${kind} token: ${String(err)}`);
    return null;
  }
}

export function storeSlackToken(kind: SlackTokenKind, token: string | null): boolean {
  return host().secrets.set(KEY[kind], token?.trim() || null);
}

/// The commonest mistake is pasting one token into the other's box — they
/// look alike and Slack shows both on neighbouring pages.
export function validateSlackToken(kind: SlackTokenKind, raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  if (token.startsWith(PREFIX[kind === 'bot' ? 'app' : 'bot']))
    return kind === 'bot'
      ? 'That is an app-level token (xapp-). The bot token starts with xoxb-.'
      : 'That is a bot token (xoxb-). The app-level token starts with xapp-.';
  if (!token.startsWith(PREFIX[kind])) return `A Slack ${kind} token starts with ${PREFIX[kind]}.`;
  if (/\s/.test(token)) return 'The token has a space in it — copy it again.';
  return null;
}

export function slackEnabled(): boolean {
  const env = process.env[SLACK_ENABLED_ENV]?.trim().toLowerCase();
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  try {
    return !!Store.load().settings.slackEnabled;
  } catch {
    return false;
  }
}
