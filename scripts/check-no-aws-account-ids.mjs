#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT_ID = /(^|[^0-9])([0-9]{12})(?![0-9])/g;
const REDACTED = '[REDACTED:aws-account-id]';

export function findAwsAccountIds(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : bytes;
  const findings = [];

  for (const match of text.matchAll(ACCOUNT_ID)) {
    const offset = match.index + match[1].length;
    // Twelve digits inside a full git commit hash (a pinned action, say) are
    // part of the hash, not an account.
    if (insideCommitHash(text, offset, match[2].length)) continue;
    const before = text.slice(0, offset);
    const lastNewline = before.lastIndexOf('\n');
    findings.push({
      line: before.split('\n').length,
      column: offset - lastNewline,
    });
  }

  return findings;
}

function insideCommitHash(text, start, length) {
  let from = start;
  let to = start + length;
  while (from > 0 && /[0-9a-f]/i.test(text[from - 1])) from--;
  while (to < text.length && /[0-9a-f]/i.test(text[to])) to++;
  return to - from === 40;
}

function redactAccountIds(value) {
  return value.replace(ACCOUNT_ID, (_match, prefix) => `${prefix}${REDACTED}`);
}

function annotationProperty(value) {
  return redactAccountIds(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function repositoryFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return output.toString('utf8').split('\0').filter(Boolean);
}

export function scanRepository() {
  let count = 0;

  for (const file of repositoryFiles()) {
    const safeFile = annotationProperty(file);
    for (const finding of findAwsAccountIds(file)) {
      count += 1;
      console.error(
        `::error file=${safeFile}::` +
          `AWS account ID detected in a repository path (${REDACTED}); rename the file.`,
      );
    }

    const stat = lstatSync(file);
    const contents = stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file);
    for (const finding of findAwsAccountIds(contents)) {
      count += 1;
      console.error(
        `::error file=${safeFile},line=${finding.line},col=${finding.column}::` +
          `AWS account ID detected (${REDACTED}); remove or split the fixture value.`,
      );
    }
  }

  if (count > 0) {
    console.error(`Blocked ${count} AWS account ID occurrence${count === 1 ? '' : 's'}. Values were not printed.`);
    process.exitCode = 1;
  } else {
    console.log('No AWS account IDs found in repository files.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  scanRepository();
}
