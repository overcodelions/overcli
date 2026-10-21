// The Slack app's manifest, as the server hands it to an admin: Connect →
// Slack shows it to copy and links to Slack's "create from a manifest" page
// with it filled in. slack-app-manifest.yml beside this is the same app for
// people reading the repo; slackManifest.test.ts keeps the two in step.

import { stringify } from 'yaml';

export function slackManifest(): Record<string, unknown> {
  return {
    display_information: {
      name: 'overgo',
      description: "Ask your org's AI workers for anything — mention @overgo or DM it. Workers ask their managers here too.",
    },
    features: {
      bot_user: { display_name: 'overgo', always_online: true },
      slash_commands: [
        { command: '/overgo', description: "Join your org's AI workers", usage_hint: 'join', should_escape: false },
        { command: '/worker', description: 'Your AI workers — list, ask, pause, what is waiting on you', usage_hint: '[name] [ask <text> | pause | resume] | waiting', should_escape: false },
        { command: '/team', description: 'Give a team of workers a task, make a team, or list teams', usage_hint: "[team name]: [what you want back] | new [what it's for]", should_escape: false },
        { command: '/hire', description: 'Hire an AI worker', usage_hint: '<what it should do, for whom, from which sources>', should_escape: false },
        { command: '/idea', description: 'Put an idea into a process, or see where yours are', usage_hint: '[process name:] <the idea>', should_escape: false },
      ],
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write', 'chat:write.customize', 'im:write', 'im:history', 'commands', 'users:read', 'users:read.email',
          'channels:history', 'groups:history', 'reactions:read', 'app_mentions:read', 'files:read', 'files:write',
        ],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ['message.im', 'message.channels', 'message.groups', 'app_mention', 'reaction_added'] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/// What Connect → Slack shows: the manifest to copy, and Slack's new-app
/// page with it already filled in.
export function slackManifestForConsole(): { yaml: string; createUrl: string } {
  const manifest = slackManifest();
  return {
    yaml: stringify(manifest),
    createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
  };
}
