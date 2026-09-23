// What the CLI setup guide says, worked out apart from how it is drawn: which
// CLIs exist, what to run for each, and — from the machine's backend health —
// which rows lead, which fold under "Also supported", and the one sentence at
// the top. Kept out of the component so it can be tested without a DOM.

import type { Backend, BackendHealth } from '@shared/types';

export interface CliSetupEntry {
  backend: Backend;
  name: string;
  /// One line on what you get, so the choice isn't five identical npm
  /// commands with different package names.
  blurb: string;
  install: string;
  auth: string | null;
  docs: string;
  /// Shown above the fold as a suggested starting point. The rest sit
  /// under "Also supported" — every CLI works, but a first-run screen
  /// that refuses to have an opinion is a worse first run.
  featured?: boolean;
}

export const CLI_SETUP: CliSetupEntry[] = [
  {
    backend: 'claude',
    name: 'Claude',
    blurb: 'Anthropic’s Claude Code. Broadest tool + agent support in overcli.',
    install: 'npm install -g @anthropic-ai/claude-code',
    auth: 'claude auth login',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup',
    featured: true,
  },
  {
    backend: 'codex',
    name: 'Codex',
    blurb: 'OpenAI’s Codex CLI. Signs in with your ChatGPT account.',
    install: 'npm install -g @openai/codex',
    auth: 'codex login',
    docs: 'https://github.com/openai/codex',
    featured: true,
  },
  {
    backend: 'gemini',
    name: 'Gemini',
    blurb: 'Google’s Gemini CLI.',
    install: 'npm install -g @google/gemini-cli',
    auth: 'gemini auth login',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    backend: 'copilot',
    name: 'Copilot',
    blurb: 'GitHub Copilot CLI, on your GitHub account.',
    install: 'npm install -g @github/copilot',
    auth: 'copilot login',
    docs: 'https://www.npmjs.com/package/@github/copilot',
  },
  {
    backend: 'ollama',
    name: 'Ollama',
    blurb: 'Open models running locally. No account, no network.',
    install: 'Download from ollama.com',
    auth: null,
    docs: 'https://ollama.com/download',
  },
];

export const ALL_SETUP_BACKENDS = CLI_SETUP.map((c) => c.backend);

/// "Claude", "Claude and Codex", "Claude, Codex and Ollama".
export function joinNames(names: string[]): string {
  if (names.length === 0) return 'No CLI';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type CliSetupRowData = CliSetupEntry & { health?: BackendHealth; kind: BackendHealth['kind'] };

export interface CliSetupPlan {
  ready: CliSetupRowData[];
  /// Everything not ready yet, in `CLI_SETUP` order.
  rows: CliSetupRowData[];
  /// Installed but signed out — one click from done, so these lead.
  signIn: CliSetupRowData[];
  featured: CliSetupRowData[];
  /// Not featured and not signed out: folded under "Also supported".
  others: CliSetupRowData[];
  /// Nothing left to ask for.
  done: boolean;
  headline: string;
  subline: string;
}

export function cliSetupPlan(backendHealth: Record<string, BackendHealth>): CliSetupPlan {
  const all = CLI_SETUP.map((cli) => ({
    ...cli,
    health: backendHealth[cli.backend],
    // Absent means we haven't heard about it; treat as missing rather than
    // rendering an empty row.
    kind: backendHealth[cli.backend]?.kind ?? 'missing',
  }))
    // `unknown` is only ever produced by the store for a backend the user
    // turned off in Settings. Telling someone to npm-install something they
    // deliberately disabled is noise.
    .filter((r) => r.kind !== 'unknown');
  const ready = all.filter((r) => r.kind === 'ready');
  const rows = all.filter((r) => r.kind !== 'ready');

  // An installed-but-signed-out CLI is one click from done, so it leads —
  // it's a far shorter path than any install below it.
  const signIn = rows.filter((r) => r.kind === 'unauthenticated');
  const rest = rows.filter((r) => r.kind !== 'unauthenticated');
  const featured = rest.filter((r) => r.featured);
  const others = rest.filter((r) => !r.featured);
  // The sheet on a machine that is already working. There is nothing to ask
  // for, so it says the one thing the user opened it to find out.
  const done = rows.length === 0;

  const headline = done
    ? "You're set up"
    : signIn.length > 0
      ? `Sign in to ${joinNames(signIn.map((r) => r.name))} to get started`
      : 'Install a coding CLI to get started';
  const subline = done
    ? `${joinNames(ready.map((r) => r.name))} ${ready.length === 1 ? 'is' : 'are'} signed in and ready to run. Nothing else to install.`
    : signIn.length > 0
      ? `${signIn.length === 1 ? 'It’s' : 'They’re'} already installed — one sign-in and you're in. overcli picks it up automatically.`
      : 'overcli drives the coding CLIs you sign into — there are no API keys to paste here. Set up any one of these and this screen unlocks on its own.';

  return { ready, rows, signIn, featured, others, done, headline, subline };
}
