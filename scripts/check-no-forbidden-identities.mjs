import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Keep private addresses out of the public repository without storing them
// here in plaintext.
const FORBIDDEN_EMAIL_HASHES = new Set([
  '5946050b304dbbcf78df001cdc0d12a2449a248d5f53adffb270141111e4dd78',
  'bb479488faf55e70fa1e7459ad87bae074c5f11a663d4af6021c582ce5762f1e',
]);

function forbidden(email) {
  const normalized = email.trim().toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return FORBIDDEN_EMAIL_HASHES.has(hash);
}

function containsForbiddenEmail(text) {
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return emails.some(forbidden);
}

let content;
if (process.argv.includes('--current')) {
  content = ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']
    .map((variable) => execFileSync('git', ['var', variable], { encoding: 'utf8' }))
    .join('\n');
} else if (process.argv.includes('--message-file')) {
  const index = process.argv.indexOf('--message-file');
  const path = process.argv[index + 1];
  if (!path) throw new Error('--message-file requires a path');
  content = readFileSync(path, 'utf8');
} else {
  const args = ['log', '--format=%ae%x00%ce%x00%B%x00'];
  if (process.argv.includes('--pull-request')) {
    // actions/checkout checks out a synthetic GitHub merge commit for PRs.
    // Scan both real parents and their history, excluding that ephemeral commit.
    args.splice(1, 0, 'HEAD^@');
  } else if (process.argv.includes('--all')) {
    args.splice(1, 0, '--all');
  }
  const revisionIndex = process.argv.indexOf('--revision');
  if (revisionIndex !== -1) {
    const revision = process.argv[revisionIndex + 1];
    if (!revision) throw new Error('--revision requires a revision or range');
    args.splice(1, 0, revision);
  }
  content = execFileSync('git', args, { encoding: 'utf8' });
}

if (containsForbiddenEmail(content)) {
  console.error('Forbidden private email found in Git metadata or a commit message.');
  process.exit(1);
}

console.log('Git metadata and commit messages contain no forbidden private identities.');
