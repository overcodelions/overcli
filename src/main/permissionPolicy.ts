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

import fs from 'node:fs';
import path from 'node:path';
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

/// Shell commands that only read, with only the flags in `SAFE_FLAGS`.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg',
  'find', 'stat', 'du', 'df', 'which', 'type', 'sort', 'cut', 'diff',
  'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'nl', 'true',
  'uname', 'column', 'tac', 'rev', 'cmp', 'file',
]);

/// The flags each read-only command may take. Anything else — an unknown
/// flag, a GNU abbreviation (`--out`), a combined short flag carrying a
/// writer (`-uo`) — is not read-only. A command missing here takes none.
const SAFE_FLAGS: Record<string, RegExp> = {
  ls: /^(-[aAlhRtrSd1FGiks]+|--all|--color(=\w+)?)$/,
  cat: /^-[nbAsvetTE]+$/,
  head: /^(-[nc]\d*|-\d+|-[qv]|--lines=\d+|--bytes=\d+)$/,
  tail: /^(-[nc]\d*|-\d+|-[qvf]|--lines=\d+|--bytes=\d+)$/,
  wc: /^-[lwcmL]+$/,
  echo: /^-[neE]+$/,
  grep: /^(-[iwvcnlLhHrRsoqEFxz]+|-[ABCm]\d*|-e|-f|--include=.*|--exclude=.*|--exclude-dir=.*|--color(=\w+)?)$/,
  rg: /^(-[inlwvcFSsuHNo]+|-[ABCm]\d*|-[gteT]|--hidden|--files|--no-ignore|--line-number|--ignore-case|--fixed-strings|--count|--files-with-matches|--glob=.*|--type=.*|--context=\d+)$/,
  find: /^-(name|iname|type|path|ipath|maxdepth|mindepth|size|mtime|newer|print|print0|not|o|a|empty|regex|L)$/,
  stat: /^(-[Lt]+|-c|--format=.*|--printf=.*)$/,
  du: /^(-[shacdkmx]+|-d\d*|--max-depth=\d+)$/,
  df: /^-[hikTPl]+$/,
  which: /^-a$/,
  type: /^-a$/,
  sort: /^(-[bdfghiMnrRsuVz]+|-[kt]|--reverse|--numeric-sort|--unique|--human-numeric-sort|--ignore-case|--version-sort|--key=.*|--field-separator=.*)$/,
  cut: /^(-d.*|-f[\d,-]*|-c[\d,-]*|-b[\d,-]*|-s|--delimiter=.*|--fields=.*)$/,
  diff: /^(-[uNqrwBbiay]+|-U\d*|--unified(=\d+)?|--brief|--recursive|--ignore-all-space|--color(=\w+)?)$/,
  basename: /^-[as]$/,
  realpath: /^-[esqmz]+$/,
  readlink: /^-[fmenqz]+$/,
  // Not -C (compiles a magic file) or -m (loads one).
  file: /^(-[bhiLz]+|--brief|--mime(-type|-encoding)?)$/,
  date: /^(-[uRI]\w*|-d|--date(=.*)?|--iso-8601(=\w+)?)$/,
  uname: /^-[asnrvmpio]+$/,
  nl: /^(-b\S*|-n\S*|-w\d*)$/,
  column: /^(-[tnex]+|-s\S*)$/,
  tac: /^-b$/,
  cmp: /^(-[lsb]+|-n\d*)$/,
};
SAFE_FLAGS.egrep = SAFE_FLAGS.grep;
SAFE_FLAGS.fgrep = SAFE_FLAGS.grep;

/// Flags shared by git's history and diff readers (`log`, `show`, `diff`…).
/// Spelled out in full: git accepts any unambiguous prefix of a long flag
/// (`--open` for `--open-files-in-pager`, `--out` for `--output`), so a
/// list of flags to refuse can never be complete. Only these are accepted.
const GIT_HISTORY_FLAGS =
  /^(-p|-u|-s|-z|-w|-b|-R|-M\d*%?|-C\d*%?|-U\d*|-n\d*|-\d+|--patch|--no-patch|--stat(=[\d,]+)?|--shortstat|--numstat|--dirstat(=[\w,]+)?|--summary|--name-only|--name-status|--raw|--check|--exit-code|--quiet|--oneline|--graph|--decorate(=\w+)?|--no-decorate|--all|--branches|--tags|--remotes|--first-parent|--no-merges|--merges|--reverse|--follow|--topo-order|--date-order|--full-history|--simplify-by-decoration|--boundary|--left-right|--cherry-pick|--source|--format=.*|--pretty(=.*)?|--abbrev(=\d+)?|--abbrev-commit|--no-abbrev|--max-count=\d+|--skip=\d+|--since(=.*)?|--until(=.*)?|--after(=.*)?|--before(=.*)?|--author(=.*)?|--committer(=.*)?|--grep(=.*)?|--date=.*|--relative-date|--diff-filter=.*|--find-renames(=\d+%?)?|--cached|--staged|--merge-base|--no-index|--unified=\d+|--word-diff(=\w+)?|--ignore-all-space|--ignore-space-change|--ignore-blank-lines|--minimal|--patience|--histogram|--color(=\w+)?|--no-color|--no-ext-diff|--no-textconv|--count|--objects|-S.+|-G.+|-L.+|--)$/;

/// git subcommands that only read, each with the flags it may take. `branch`,
/// `tag`, `remote`, `stash`, `worktree` and `reflog` read only in their
/// listing forms — see `gitReadsOnly`.
const READ_ONLY_GIT: Record<string, RegExp> = {
  status: /^(-[sbuvz]+|-u\w+|--short|--branch|--long|--porcelain(=v\d)?|--untracked-files(=\w+)?|--ignored(=\w+)?|--ahead-behind|--no-ahead-behind|--show-stash|--verbose|--)$/,
  diff: GIT_HISTORY_FLAGS,
  log: GIT_HISTORY_FLAGS,
  show: GIT_HISTORY_FLAGS,
  whatchanged: GIT_HISTORY_FLAGS,
  'rev-list': GIT_HISTORY_FLAGS,
  shortlog: /^(-[nsec]+|--numbered|--summary|--email|--committer|--all|--no-merges|--since=.*|--until=.*|--author=.*|--format=.*|--group=.*|--)$/,
  blame: /^(-[lstfnecwp]+|-L.*|\d+,[+-]?\d*|-M\d*|-C\d*|--porcelain|--line-porcelain|--incremental|--root|--show-email|--show-name|--show-number|--date=.*|--abbrev=\d+|--ignore-rev=.*|--)$/,
  grep: /^(-[nivwcLlhHEFPIqozapW]+|-[ABC]\d*|-e|--line-number|--ignore-case|--word-regexp|--invert-match|--count|--files-with-matches|--files-without-match|--name-only|--cached|--untracked|--no-index|--exclude-standard|--no-exclude-standard|--recurse-submodules|--heading|--break|--full-name|--column|--only-matching|--show-function|--function-context|--context=\d+|--after-context=\d+|--before-context=\d+|--max-depth=-?\d+|--threads=\d+|--and|--or|--not|--all-match|--text|--null|--quiet|--basic-regexp|--extended-regexp|--fixed-strings|--perl-regexp|--color(=\w+)?|--no-color|--)$/,
  'rev-parse': /^(-q|--quiet|--verify|--short(=\d+)?|--abbrev-ref(=\w+)?|--symbolic|--symbolic-full-name|--show-toplevel|--show-prefix|--show-cdup|--git-dir|--git-common-dir|--absolute-git-dir|--is-inside-work-tree|--is-inside-git-dir|--is-bare-repository|--is-shallow-repository|--all|--branches|--tags|--remotes|--)$/,
  'ls-files': /^(-[cdmoiskutvfz]+|-x.+|--cached|--deleted|--modified|--others|--ignored|--stage|--unmerged|--killed|--directory|--no-empty-directory|--exclude-standard|--exclude=.*|--full-name|--error-unmatch|--eol|--format=.*|--)$/,
  'ls-tree': /^(-[rtdlz]+|--name-only|--name-status|--object-only|--full-name|--full-tree|--long|--abbrev(=\d+)?|--format=.*|--)$/,
  describe: /^(--tags|--all|--always|--long|--contains|--exact-match|--first-parent|--abbrev=\d+|--candidates=\d+|--dirty(=\S*)?|--broken(=\S*)?|--match=.*|--exclude=.*)$/,
  'cat-file': /^(-[tspe]|--batch|--batch-check|--batch-command|--batch-all-objects|--buffer|--unordered|--follow-symlinks|--allow-unknown-type)$/,
  'merge-base': /^(-a|--all|--octopus|--independent|--is-ancestor|--fork-point)$/,
  'name-rev': /^(--name-only|--tags|--all|--always|--undefined|--no-undefined|--refs=.*|--exclude=.*|--annotate-stdin)$/,
  'for-each-ref': /^(--format=.*|--sort=.*|--count=\d+|--points-at(=.*)?|--merged(=.*)?|--no-merged(=.*)?|--contains(=.*)?|--no-contains(=.*)?|--ignore-case|--shell|--perl|--python|--tcl)$/,
  'check-ignore': /^(-[vnqz]+|--verbose|--non-matching|--quiet|--no-index|--stdin|--)$/,
  'show-ref': /^(-[dsq]|--heads|--branches|--tags|--head|--dereference|--hash(=\d+)?|--abbrev(=\d+)?|--verify|--exists|--quiet)$/,
};
READ_ONLY_GIT.reflog = GIT_HISTORY_FLAGS;
READ_ONLY_GIT.stash = GIT_HISTORY_FLAGS;
READ_ONLY_GIT.worktree = /^(-v|-z|--verbose|--porcelain)$/;
READ_ONLY_GIT.remote = /^(-v|--verbose)$/;

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
      // Discarding output or merging stderr into stdout writes nothing. Both
      // must end the word: `>/dev/nullx` and `>&1foo` write a file.
      const rest = line.slice(i);
      const m = /^>>?\s*\/dev\/null(?=$|[\s;|&)])/.exec(rest) ?? /^>&(\d+|-)(?=$|[\s;|&)<>])/.exec(rest);
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
  // Only `-C dir` and `--no-pager` before the subcommand: `-c k=v`,
  // `--config-env` and `--exec-path` can make any read run a program.
  for (let i = 1; i < w.length && w[i].startsWith('-'); i++) {
    if (w[i] === '-C') { i++; continue; }
    if (w[i] !== '--no-pager') return false;
  }
  const args = gitArgs(w);
  const sub = args[0];
  if (!sub) return false;
  if (sub === 'branch' || sub === 'tag') {
    // Listing flags only; a bare name creates one.
    return args.slice(1).every((a) => /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--merged|--no-merged|--contains|--sort=.*|--format=.*)$/.test(a));
  }
  if (sub === 'worktree' && args[1] !== 'list') return false;
  if (sub === 'stash' && args[1] !== 'list' && args[1] !== 'show') return false;
  if (sub === 'remote' && args[1] && !['-v', '--verbose', 'get-url'].includes(args[1])) return false;
  if (sub === 'reflog' && args[1] && args[1] !== 'show') return false;
  const flags = Object.prototype.hasOwnProperty.call(READ_ONLY_GIT, sub) ? READ_ONLY_GIT[sub] : null;
  if (!flags) return false;
  // Every flag must be one this subcommand reads with — see GIT_HISTORY_FLAGS
  // for why this is a list of flags to accept, not to refuse.
  return args.slice(1).every((a) => !a.startsWith('-') || flags.test(a));
}

/// True when a word would read differently to bash than to `words()`:
/// quotes or backslashes inside it (`--p''re`), or a `$` expansion outside
/// single quotes. Such a line is never read-only.
function hasTrickyWord(command: string): boolean {
  const re = /"(?:\\.|[^"\\])*"|'[^']*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const t = m[0];
    if (/^'[^']*'$/.test(t)) continue;
    if (/^"[^"\\$`]*"$/.test(t)) continue;
    if (/["'\\$`]/.test(t)) return true;
  }
  return false;
}

function commandReadsOnly(command: string): boolean {
  if (hasTrickyWord(command)) return false;
  const w = words(command);
  const cmd = w[0];
  if (!cmd) return true;
  if (cmd === 'git') return gitReadsOnly(w);
  // `cd` only moves where the next command looks, and a read anywhere is
  // already a read. Models open nearly every line with it.
  if (cmd === 'cd') return w.length <= 2 && !w[1]?.startsWith('-');
  if (cmd === 'sed') return sedPrintsOnly(w);
  if (!READ_ONLY_COMMANDS.has(cmd)) return false;
  const safe = SAFE_FLAGS[cmd];
  if (w.slice(1).some((a) => a.startsWith('-') && !(safe && safe.test(a)))) return false;
  return true;
}

/// `sed -n 120,180p file`: the way models page through a file. Only a
/// printed line range counts. A sed script can also write (`w`), run a
/// command (`e`) or edit in place (`-i`), and none of those fit the shape.
function sedPrintsOnly(w: string[]): boolean {
  const args = w.slice(1);
  const scriptAt = args.findIndex((a) => !a.startsWith('-'));
  if (scriptAt < 0) return false;
  if (!args.slice(0, scriptAt).every((a) => a === '-n')) return false;
  if (!/^(\d+|\$)(,(\d+|\$))?p$/.test(args[scriptAt])) return false;
  return args.slice(scriptAt + 1).every((a) => !a.startsWith('-'));
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

/// The folders a read may reach: each root, where it really is, and, for a
/// workspace's folder (links to each repo, and not a repo itself), the
/// folders its links lead to. A link inside a repo is followed nowhere: it
/// could point anywhere on the server.
function readableRoots(roots: readonly string[]): string[] {
  const out = new Set<string>();
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  for (const r of roots) {
    out.add(path.resolve(r));
    const rr = real(r);
    if (!rr) continue;
    out.add(rr);
    if (fs.existsSync(path.join(rr, '.git'))) continue;
    try {
      for (const e of fs.readdirSync(rr, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) continue;
        const to = real(path.join(rr, e.name));
        if (to && fs.statSync(to).isDirectory()) out.add(to);
      }
    } catch {
      // not a folder
    }
  }
  return [...out];
}

/// Whether a path stays inside `roots`, both as named and where it really
/// leads, so a link in the repo can't reach the server's secrets.
function insideRoots(roots: readonly string[]): (p: string) => boolean {
  const allowed = readableRoots(roots);
  const within = (p: string) => allowed.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  return (p: string) => {
    if (!within(p)) return false;
    try {
      return within(fs.realpathSync(p));
    } catch {
      return true; // not there: nothing to read
    }
  };
}

/// A shell line that only reads, run from `cwd`, naming nothing outside
/// `roots`: a worker looking around its own repo with `git log`, `ls` or
/// `rg`. Each path it names must stay inside, where it really leads too.
export function bashReadsOnlyUnder(command: string, cwd: string, roots: readonly string[]): boolean {
  if (!command.trim() || !roots.length) return false;
  const inside = insideRoots(roots);
  let here = path.resolve(cwd);
  if (!inside(here)) return false;
  const split = splitCommands(command);
  if (split.opaque) return false;
  // `cd repo && git log` is how a model reads a repo. `cd` changes nothing:
  // it only says where the rest runs, so it is stepped past (staying inside
  // the folders) and the rest judged from there. Refusing it made a code
  // reader give up on the shell for its whole run.
  const rest: Array<{ c: string; at: string }> = [];
  for (const c of split.commands) {
    const w = words(c);
    if (w[0] === 'cd') {
      if (w.length !== 2 || w[1] === '-' || w[1].startsWith('~') || w[1].includes('$')) return false;
      here = path.resolve(here, w[1]);
      if (!inside(here)) return false;
      continue;
    }
    rest.push({ c, at: here });
  }
  if (!rest.length) return true;
  if (!isReadOnlyBashCommand(rest.map((r) => r.c).join(' && '))) return false;
  for (const { c, at } of rest) {
    const here = at;
    const w = words(c);
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === '/dev/null' || /^\d?>&\d$/.test(a)) continue;
      if (a.startsWith('~') || a.includes('$')) return false;
      if (a.startsWith('-')) {
        // `--flag=path` names a path too.
        const eq = a.indexOf('=');
        if (eq > 0 && /[/.]/.test(a.slice(eq + 1)) && !inside(path.resolve(here, a.slice(eq + 1)))) return false;
        continue;
      }
      // Anything that names a path, or is one here (a link in the repo).
      const p = path.resolve(here, a);
      if ((a.includes('/') || a.startsWith('.') || fs.existsSync(p)) && !inside(p)) return false;
    }
  }
  return true;
}

/// The tools that read files, and the input fields naming what they read.
/// Unset, each reads from the run's folder.
const FILE_READ_FIELDS: Record<string, readonly string[]> = {
  Read: ['file_path'],
  Grep: ['path'],
  Glob: ['path'],
  LS: ['path'],
  NotebookRead: ['notebook_path'],
};

/// A file tool's call that names nothing outside `roots`. A glob that is
/// absolute or climbs out (`/etc/*`, `../../*`) leaves the folder too.
function fileReadWithin(toolName: string, input: unknown, cwd: string, roots: readonly string[]): boolean {
  if (!roots.length) return false;
  const inside = insideRoots(roots);
  const here = path.resolve(cwd);
  if (!inside(here)) return false;
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const field of FILE_READ_FIELDS[toolName]) {
    const v = args[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.startsWith('~') || v.includes('$')) return false;
    if (!inside(path.resolve(here, v))) return false;
  }
  const glob = toolName === 'Glob' ? args.pattern : toolName === 'Grep' ? args.glob : undefined;
  if (glob !== undefined) {
    if (typeof glob !== 'string' || path.isAbsolute(glob) || glob.startsWith('~') || glob.split(/[\\/]/).includes('..')) return false;
  }
  return true;
}

/// A call that only reads and reaches nothing outside `roots`: a file read
/// inside them, another read-only tool, a read-only MCP call, or a shell
/// line `bashReadsOnlyUnder` accepts.
export function readsOnlyWithin(toolName: string, input: unknown, cwd: string, roots: readonly string[]): boolean {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = toolName === 'Bash' ? { command: input } : {};
    }
  }
  if (Object.prototype.hasOwnProperty.call(FILE_READ_FIELDS, toolName)) return fileReadWithin(toolName, parsed, cwd, roots);
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__')) return isReadOnlyMcpTool(toolName);
  if (toolName !== 'Bash') return false;
  const cmd = bashCommandOf(parsed);
  return !!cmd && bashReadsOnlyUnder(cmd, cwd, roots);
}

/// The file tools that write, and the input field naming what they write.
const FILE_WRITE_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/// A file write whose target is an absolute path inside `dir`: a worker's
/// own files folder, the one place a reader may keep what it made.
export function writesOnlyIn(toolName: string, input: unknown, dir: string): boolean {
  const field = FILE_WRITE_FIELDS[toolName];
  if (!field) return false;
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return false;
    }
  }
  const args = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const target = args[field];
  return typeof target === 'string' && path.isAbsolute(target) && (path.resolve(target) + path.sep).startsWith(path.resolve(dir) + path.sep);
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
