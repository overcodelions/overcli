import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Keep the address itself out of the public repository while preventing it
// from appearing in author or committer metadata.
const FORBIDDEN_EMAIL_HASHES = new Set([
  '5946050b304dbbcf78df001cdc0d12a2449a248d5f53adffb270141111e4dd78',
]);

function forbidden(email) {
  const normalized = email.trim().toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return FORBIDDEN_EMAIL_HASHES.has(hash);
}

function emailFromIdentity(identity) {
  return /<([^>]+)>/.exec(identity)?.[1] ?? '';
}

let found = false;
if (process.argv.includes('--current')) {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const identity = execFileSync('git', ['var', variable], { encoding: 'utf8' });
    if (forbidden(emailFromIdentity(identity))) found = true;
  }
} else {
  const args = ['log', '--format=%ae%x00%ce%x00'];
  if (process.argv.includes('--all')) args.splice(1, 0, '--all');
  const identities = execFileSync('git', args, { encoding: 'utf8' }).split('\0');
  found = identities.some(forbidden);
}

if (found) {
  console.error('Forbidden private email found in Git author or committer metadata.');
  process.exit(1);
}

console.log('Git author and committer metadata contain no forbidden private identities.');
