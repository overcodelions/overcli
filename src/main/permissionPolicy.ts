// Which tool calls a chat conversation asks about, and what "Always allow"
// grants.
//
// The approval card used to ask about everything and remember answers by
// tool name. Both ends were wrong. Reading a file or running `git status`
// asked every time, which taught people to click through cards — and one
// "Always allow" on `npm test` wrote a bare `Bash` rule, after which
// `git push` and `rm -rf` ran without a word.
//
// So the decision now reads the call, not just its name:
//   - a call that only reads is allowed without a card;
//   - a command that is hard to take back (a push, a hard reset, a recursive
//     delete, a merge or publish) always gets a card, whatever was allowed
//     before — `riskyAskRules` makes Claude Code itself ask, so an old bare
//     `Bash` rule in settings.json can't wave it through;
//   - "Always allow" grants a command prefix (`Bash(npm test:*)`), never the
//     whole shell.
//
// Everything here is a guess from the text of the call. The guesses are
// one-sided on purpose: anything we can't place is neither read-only nor
// safe to remember, so the worst a wrong guess costs is one extra card.

import { isReadOnlyMcpTool } from '../shared/flows/mcpTools';

/// Tools that cannot change anything. Launching a subagent is here because
/// the subagent's own calls come back through the same gate.
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
  'BashOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Task',
  'Agent',
]);

/// Shell commands that only read, whatever their arguments — except the
/// flags in `UNSAFE_FLAGS`, which turn a few of them into writers.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg',
  'find', 'tree', 'file', 'stat', 'du', 'df', 'which', 'type', 'sort', 'uniq', 'cut', 'diff',
  'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'jq', 'nl', 'cd', 'true',
  'env', 'printenv', 'uname', 'hostname', 'id', 'ps', 'lsof', 'column', 'tac', 'rev', 'cmp',
]);

const UNSAFE_FLAGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output)/,
  // `env FOO=1 cmd` runs cmd; bare `env` only prints.
  env: /./,
};

/// git subcommands that only read. `branch`, `tag`, `remote` and `stash`
/// read only in their listing forms — see `gitReadsOnly`.
const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'describe',
  'shortlog', 'cat-file', 'merge-base', 'rev-list', 'whatchanged', 'name-rev', 'for-each-ref',
  'check-ignore', 'show-ref', 'worktree list', 'reflog',
]);

/// Commands that are hard or impossible to take back, or act outside this
/// machine. Matched as a prefix of each command in a compound line.
export const RISKY_COMMAND_PREFIXES = [
  'git push',
  'git reset --hard',
  'git clean',
  'git branch -D',
  'git checkout --',
  'git restore',
  'git stash drop',
  'git stash clear',
  'git rebase',
  'git filter-branch',
  'git tag -d',
  'git update-ref -d',
  'gh pr merge',
  'gh pr create',
  'gh pr close',
  'gh issue close',
  'gh release',
  'gh repo delete',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'cargo publish',
  'docker push',
  'kubectl delete',
  'kubectl apply',
  'terraform apply',
  'terraform destroy',
  'sudo',
];

/// Claude Code `ask` rules for the risky prefixes. An ask rule beats an
/// allow rule, so passing these on the command line keeps a `Bash` grant
/// already sitting in the user's settings.json from skipping the card.
/// `rm` is spelled out because its dangerous form is a flag, not a prefix.
export function riskyAskRules(): string[] {
  const rules = RISKY_COMMAND_PREFIXES.map((p) => `Bash(${p}:*)`);
  for (const rm of ['rm -r', 'rm -rf', 'rm -fr', 'rm -R', 'rm -Rf', 'rm -fR']) rules.push(`Bash(${rm}:*)`);
  return rules;
}

/// Split a shell line into its simple commands: on `&&`, `||`, `;`, `|`,
/// `&` and newlines that aren't inside quotes. Returns null when the line
/// does something we can't see through — command substitution, process
/// substitution, or a write redirect — so callers treat it as unknown.
export function splitCommands(line: string): { commands: string[]; writes: boolean; opaque: boolean } {
  const commands: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let writes = false;
  let opaque = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    // `$(` and backticks run a command even inside double quotes.
    if (c === '`' || (c === '$' && line[i + 1] === '(')) opaque = true;
    if (quote === '"') {
      if (c === '"') quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === '<' || c === '>') && line[i + 1] === '(') opaque = true;
    if (c === '>') {
      // Discarding output or merging stderr into stdout writes nothing.
      const rest = line.slice(i);
      const m = /^>>?\s*\/dev\/null/.exec(rest) ?? /^>&\d/.exec(rest);
      if (m) {
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
      writes = true;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // `2>&1` was consumed above; a lone `&` backgrounds, which still splits.
      if ((c === '|' || c === '&') && line[i + 1] === c) i++;
      if (cur.trim()) commands.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) commands.push(cur.trim());
  return { commands, writes, opaque };
}

/// Shell-ish word split, quotes stripped. Good enough for reading the first
/// few words of a command; not a parser.
export function words(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/// `git -C dir status` → ['status']; drops git's own leading options.
function gitArgs(w: string[]): string[] {
  const rest = w.slice(1);
  while (rest.length && rest[0].startsWith('-')) {
    const opt = rest.shift()!;
    if ((opt === '-C' || opt === '-c') && rest.length) rest.shift();
  }
  return rest;
}

function gitReadsOnly(w: string[]): boolean {
  const args = gitArgs(w);
  const sub = args[0];
  if (!sub) return false;
  if (sub === 'worktree') return args[1] === 'list';
  if (sub === 'stash') return args[1] === 'list' || args[1] === 'show';
  if (sub === 'remote') return !args[1] || ['-v', '--verbose', 'show', 'get-url'].includes(args[1]);
  if (sub === 'branch' || sub === 'tag') {
    // Listing flags only; a bare name creates one.
    return args.slice(1).every((a) => /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--merged|--no-merged|--contains|--sort=.*|--format=.*)$/.test(a));
  }
  if (sub === 'reflog') return !args[1] || args[1] === 'show';
  return READ_ONLY_GIT.has(sub);
}

function commandReadsOnly(command: string): boolean {
  const w = words(command);
  const cmd = w[0];
  if (!cmd) return true;
  if (cmd === 'git') return gitReadsOnly(w);
  if (!READ_ONLY_COMMANDS.has(cmd)) return false;
  const unsafe = UNSAFE_FLAGS[cmd];
  if (unsafe && w.slice(1).some((a) => unsafe.test(a))) return false;
  return true;
}

/// True when every command in the line only reads, and nothing is written
/// by a redirect.
export function isReadOnlyBashCommand(line: string): boolean {
  const { commands, writes, opaque } = splitCommands(line);
  if (writes || opaque || commands.length === 0) return false;
  return commands.every(commandReadsOnly);
}

function isRiskyCommand(command: string): boolean {
  const w = words(command);
  // `rm` is risky when recursive, however the flags are spelled.
  if (w[0] === 'rm') return w.slice(1).some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  const normalized = w.join(' ');
  if (w[0] === 'git') {
    // Read `git -C dir push` as `git push`.
    const args = gitArgs(w);
    const asGit = ['git', ...args].join(' ');
    return RISKY_COMMAND_PREFIXES.some((p) => asGit === p || asGit.startsWith(p + ' '));
  }
  return RISKY_COMMAND_PREFIXES.some((p) => normalized === p || normalized.startsWith(p + ' '));
}

/// True when any command in the line is one we always ask about. Opaque
/// lines (`$(...)`) are checked on what we can see; the card still shows.
export function isRiskyBashCommand(line: string): boolean {
  return splitCommands(line).commands.some(isRiskyCommand);
}

function bashCommandOf(input: unknown): string | null {
  const cmd = (input as { command?: unknown } | null)?.command;
  return typeof cmd === 'string' ? cmd : null;
}

function urlHost(input: unknown): string | null {
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/// True for a call that only reads and needs no card.
export function isReadOnlyCall(toolName: string, input: unknown): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__')) return isReadOnlyMcpTool(toolName);
  if (toolName === 'Bash') {
    const cmd = bashCommandOf(input);
    return !!cmd && isReadOnlyBashCommand(cmd);
  }
  return false;
}

/// True for a call that always gets a card, even past an allow rule.
export function isRiskyCall(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const cmd = bashCommandOf(input);
  return !!cmd && isRiskyBashCommand(cmd);
}

/// Package runners whose third word names the thing being run:
/// `npm run build` grants `npm run build`, not every script.
const RUNNER_SUBCOMMANDS = new Set(['run', 'exec', 'run-script', 'x', 'dlx']);

/// The prefix "Always allow" should grant for a command: its first two
/// words (`npm test`, `python scripts/gen.py`), three for a script runner,
/// one when the second word is a flag. Null when the line has more than one
/// command that does something, or any risky one — that's "Allow" only.
export function bashAllowPrefix(line: string): string | null {
  const { commands, opaque } = splitCommands(line);
  if (opaque || commands.some(isRiskyCommand)) return null;
  const acting = commands.filter((c) => !commandReadsOnly(c));
  if (acting.length !== 1) return null;
  const w = words(acting[0]);
  if (!w.length || /=/.test(w[0])) return null;
  const take = w[1] && !w[1].startsWith('-') ? (RUNNER_SUBCOMMANDS.has(w[1]) && w[2] && !w[2].startsWith('-') ? 3 : 2) : 1;
  return w.slice(0, take).join(' ');
}

/// The rule "Always allow" writes for this call, or null when the call
/// shouldn't be remembered at all. Bash gets a command prefix; WebFetch a
/// domain; everything else its tool name, since its effect is local (an
/// edit) or already specific (an MCP tool is one action on one server).
export function alwaysAllowRule(toolName: string, input: unknown): string | null {
  if (toolName === 'Bash') {
    const cmd = bashCommandOf(input);
    const prefix = cmd ? bashAllowPrefix(cmd) : null;
    return prefix ? `Bash(${prefix}:*)` : null;
  }
  if (toolName === 'WebFetch') {
    const host = urlHost(input);
    return host ? `WebFetch(domain:${host})` : null;
  }
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') return null;
  return toolName;
}

/// Whether a remembered rule covers this call, by Claude Code's own
/// reading of its rule syntax: a bare name covers the tool; `Bash(p:*)`
/// covers a line whose every acting command starts with `p`.
export function ruleCovers(rule: string, toolName: string, input: unknown): boolean {
  if (rule === toolName) return true;
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  if (!m || m[1] !== toolName) return false;
  const body = m[2];
  if (toolName === 'Bash') {
    const cmd = bashCommandOf(input);
    if (!cmd) return false;
    const prefix = body.endsWith(':*') ? body.slice(0, -2) : body;
    const { commands, opaque } = splitCommands(cmd);
    if (opaque) return false;
    const acting = commands.filter((c) => !commandReadsOnly(c));
    return acting.length > 0 && acting.every((c) => {
      const normalized = words(c).join(' ');
      return normalized === prefix || normalized.startsWith(prefix + ' ');
    });
  }
  if (toolName === 'WebFetch' && body.startsWith('domain:')) return urlHost(input) === body.slice(7);
  return false;
}

export type AutoDecision = 'allow' | 'ask';

/// The runner's answer before a card is shown. `guarded` is false for flow
/// steps: they run with their own allowlist and an unattended policy, and
/// keep the old name-only behaviour.
export function decideBeforeAsking(
  toolName: string,
  input: unknown,
  remembered: Iterable<string>,
  guarded: boolean,
): AutoDecision {
  if (guarded && isRiskyCall(toolName, input)) return 'ask';
  for (const rule of remembered) {
    if (ruleCovers(rule, toolName, input)) return 'allow';
  }
  if (guarded && isReadOnlyCall(toolName, input)) return 'allow';
  return 'ask';
}

/// A one-line reason for the card when a call is risky. Null otherwise.
export function riskNote(toolName: string, input: unknown): string | null {
  return isRiskyCall(toolName, input)
    ? 'This is hard to undo or acts outside this machine, so overcli always asks — even if you allowed similar commands before.'
    : null;
}
