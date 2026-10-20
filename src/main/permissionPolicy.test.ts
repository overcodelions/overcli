import { describe, expect, it } from 'vitest';
import {
  alwaysAllowRule,
  bashAllowPrefix,
  decideBeforeAsking,
  isReadOnlyBashCommand,
  isReadOnlyCall,
  isRiskyBashCommand,
  riskyAskRules,
  ruleCovers,
  splitCommands,
} from './permissionPolicy';

const bash = (command: string) => ({ command });

describe('splitCommands', () => {
  it('splits on unquoted operators only', () => {
    expect(splitCommands('cd app && npm test | tail -5; echo done').commands).toEqual([
      'cd app',
      'npm test',
      'tail -5',
      'echo done',
    ]);
    expect(splitCommands(`grep "a|b; c" file`).commands).toEqual([`grep "a|b; c" file`]);
  });

  it('flags write redirects but not discards or fd merges', () => {
    expect(splitCommands('ls > out.txt').writes).toBe(true);
    expect(splitCommands('ls >> out.txt').writes).toBe(true);
    expect(splitCommands('ls 2>&1').writes).toBe(false);
    expect(splitCommands('ls 2>/dev/null').writes).toBe(false);
    expect(splitCommands(`echo "a > b"`).writes).toBe(false);
  });

  it('marks command substitution as opaque, even inside double quotes', () => {
    expect(splitCommands('echo $(rm -rf x)').opaque).toBe(true);
    expect(splitCommands('echo "`whoami`"').opaque).toBe(true);
    expect(splitCommands(`echo '$(not run)'`).opaque).toBe(false);
  });
});

describe('isReadOnlyBashCommand', () => {
  it.each([
    'ls -la',
    'cat package.json | head -20',
    'git status',
    'git -C ../other diff --stat',
    'git log --oneline -5 && git branch --show-current',
    'git branch -a',
    'git remote -v',
    'rg TODO src',
    'find . -name "*.ts"',
    'ls src && grep -rn foo .',
    'wc -l src/*.ts 2>/dev/null',
  ])('reads only: %s', (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });

  it.each([
    'rm file',
    'ls > listing.txt',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} \\;',
    'git branch new-feature',
    'git remote add origin x',
    'git commit -m x',
    'sort -o out.txt in.txt',
    'rg --pre=sh x /tmp/a',
    'rg --pre sh x .',
    'rg --pre-glob "*" --pre=sh x .',
    'rg -z x .',
    'sort --compress-program=sh a',
    'cat $(echo file)',
    'npm test',
    'FOO=1 ls',
    'env FOO=1 node x.js',
    'sed -i s/a/b/ file',
  ])('may write: %s', (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });
});

describe('isRiskyBashCommand', () => {
  it.each([
    'git push',
    'git push origin main --force',
    'git -C repo push',
    'npm test && git push',
    'git reset --hard HEAD~1',
    'rm -rf node_modules',
    'rm -r dist',
    'rm -fR dist',
    'rm --recursive dist',
    'gh pr merge 12 --squash',
    'gh pr create --title x',
    'npm publish',
    'sudo rm x',
  ])('risky: %s', (cmd) => {
    expect(isRiskyBashCommand(cmd)).toBe(true);
  });

  it.each(['git status', 'git commit -m "git push later"', 'rm file.txt', 'npm test', 'gh pr view 12', 'echo "git push"'])(
    'not risky: %s',
    (cmd) => {
      expect(isRiskyBashCommand(cmd)).toBe(false);
    },
  );
});

describe('bashAllowPrefix', () => {
  it('takes the command and its subcommand', () => {
    expect(bashAllowPrefix('npm test')).toBe('npm test');
    expect(bashAllowPrefix('npm test -- --watch=false')).toBe('npm test');
    expect(bashAllowPrefix('python scripts/gen.py --all')).toBe('python scripts/gen.py');
    expect(bashAllowPrefix('make')).toBe('make');
    expect(bashAllowPrefix('tsc --noEmit')).toBe('tsc');
  });

  it('takes the script name for script runners', () => {
    expect(bashAllowPrefix('npm run build')).toBe('npm run build');
    expect(bashAllowPrefix('pnpm exec vitest run')).toBe('pnpm exec vitest');
  });

  it('ignores read-only parts of a compound line', () => {
    expect(bashAllowPrefix('ls app && npm test 2>&1 | tail -20')).toBe('npm test');
  });

  it('refuses risky, opaque, or multi-action lines', () => {
    expect(bashAllowPrefix('git push')).toBeNull();
    expect(bashAllowPrefix('npm test && git push')).toBeNull();
    expect(bashAllowPrefix('npm install && npm test')).toBeNull();
    expect(bashAllowPrefix('node $(which x)')).toBeNull();
    expect(bashAllowPrefix('FOO=1 npm test')).toBeNull();
  });
});

describe('alwaysAllowRule', () => {
  it('never grants the whole shell', () => {
    expect(alwaysAllowRule('Bash', bash('npm test'))).toBe('Bash(npm test:*)');
    expect(alwaysAllowRule('Bash', bash('git push'))).toBeNull();
  });

  it('scopes WebFetch to a domain', () => {
    expect(alwaysAllowRule('WebFetch', { url: 'https://docs.example.com/a?b=1' })).toBe(
      'WebFetch(domain:docs.example.com)',
    );
  });

  it('keeps the tool name for local or already-specific tools', () => {
    expect(alwaysAllowRule('Edit', { file_path: '/x' })).toBe('Edit');
    expect(alwaysAllowRule('mcp__acme__send_message', {})).toBe('mcp__acme__send_message');
    expect(alwaysAllowRule('ExitPlanMode', {})).toBeNull();
  });
});

describe('ruleCovers', () => {
  it('matches a prefix rule against every acting command', () => {
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('npm test'))).toBe(true);
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('ls app && npm test -- x'))).toBe(true);
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('npm testing'))).toBe(false);
    expect(ruleCovers('Bash(npm test:*)', 'Bash', bash('npm test && npm publish'))).toBe(false);
  });

  it('matches bare names and domains', () => {
    expect(ruleCovers('Edit', 'Edit', {})).toBe(true);
    expect(ruleCovers('WebFetch(domain:a.com)', 'WebFetch', { url: 'https://a.com/x' })).toBe(true);
    expect(ruleCovers('WebFetch(domain:a.com)', 'WebFetch', { url: 'https://b.com/x' })).toBe(false);
  });
});

describe('decideBeforeAsking', () => {
  it('allows reads without a card in chat', () => {
    expect(decideBeforeAsking('Read', {}, [], true)).toBe('allow');
    expect(decideBeforeAsking('Bash', bash('git status'), [], true)).toBe('allow');
    expect(decideBeforeAsking('mcp__acme__list_issues', {}, [], true)).toBe('allow');
    expect(decideBeforeAsking('mcp__acme__create_issue', {}, [], true)).toBe('ask');
  });

  it('asks about a risky command even when the whole shell was allowed', () => {
    expect(decideBeforeAsking('Bash', bash('git push'), ['Bash'], true)).toBe('ask');
    expect(decideBeforeAsking('Bash', bash('npm test'), ['Bash'], true)).toBe('allow');
  });

  it('keeps name-only behaviour for flow steps', () => {
    expect(decideBeforeAsking('Bash', bash('git push'), ['Bash'], false)).toBe('allow');
    expect(decideBeforeAsking('Bash', bash('git status'), [], false)).toBe('ask');
  });
});

describe('riskyAskRules', () => {
  it('covers the risky prefixes and recursive rm', () => {
    const rules = riskyAskRules();
    expect(rules).toContain('Bash(git push:*)');
    expect(rules).toContain('Bash(rm -rf:*)');
  });
});

describe('isReadOnlyCall', () => {
  it('does not treat edits or plan exits as reads', () => {
    expect(isReadOnlyCall('Edit', {})).toBe(false);
    expect(isReadOnlyCall('ExitPlanMode', {})).toBe(false);
    expect(isReadOnlyCall('WebFetch', { url: 'https://x' })).toBe(false);
  });
});
