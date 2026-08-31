// Which AWS profiles can `aws sso login` be pointed at?
//
// Read straight from `~/.aws/config` rather than shelling
// `aws configure list-profiles`: that command needs the binary to exist,
// costs a Python interpreter start, and — decisive here — cannot tell an
// SSO profile from one backed by static keys, which is the only
// classification this panel needs.
//
// The INI parse is hand-rolled and deliberately narrow, matching the
// `[mcp_servers.x]` header scan in capabilities.ts. It keeps a whitelist of
// SSO-describing keys and discards every other key at parse time, so a
// secret can never reach the renderer by accident — see the secrecy test in
// awsProfiles.test.ts, which asserts exactly that.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AwsAuthOverview, AwsSsoTarget } from '../shared/types';

/// A profile name we're willing to hand to `spawn` argv and to an
/// AppleScript `do script`.
///
/// Spaces are allowed on purpose: `[profile EU Prod]` is a perfectly legal
/// thing for `aws configure sso` to write, and an earlier, tighter rule
/// dropped such profiles from the panel with no explanation — the user just
/// saw their profile missing. Spawning is argv-based so a space is a
/// non-issue there, and `awsSsoLoginCommand` double-quotes the name for the
/// Terminal path.
///
/// What stays excluded is everything that would break out of those double
/// quotes or out of AppleScript — quotes, backslash, and every character in
/// terminal.ts's FORBIDDEN_COMMAND_PATTERNS — plus a leading `-`, which
/// argv would read as a flag rather than a value.
export const AWS_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+= -]{0,127}$/;

export function isSafeAwsName(name: string): boolean {
  return AWS_NAME_RE.test(name);
}

/// Keys worth carrying out of the config file. Everything else is dropped
/// during the parse — `~/.aws/config` can legally hold
/// `aws_secret_access_key`, and this whitelist is what guarantees it never
/// travels.
const SSO_KEYS = new Set([
  'sso_session',
  'sso_start_url',
  'sso_region',
  'sso_account_id',
  'sso_role_name',
  'region',
]);

const HEADER_RE = /^[ \t]*\[([^\]\r\n]+)\][ \t]*$/;
// Both spacings occur in the wild, often in the same file:
// `sso_start_url=https://…` and `sso_start_url = https://…`.
const KEY_RE = /^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*)$/;

export interface AwsIniSection {
  header: string;
  values: Record<string, string>;
}

/// Section headers plus whitelisted keys. Tolerates CRLF, `#`/`;` comments
/// and both `=` spacings; a repeated header merges into the first section
/// with later keys winning, which is how the AWS SDKs read these files.
export function parseAwsIni(text: string, keep: Set<string> = SSO_KEYS): AwsIniSection[] {
  const sections: AwsIniSection[] = [];
  const byHeader = new Map<string, AwsIniSection>();
  let current: AwsIniSection | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const header = HEADER_RE.exec(line);
    if (header) {
      const name = header[1].trim().replace(/\s+/g, ' ');
      const existing = byHeader.get(name);
      if (existing) {
        current = existing;
      } else {
        current = { header: name, values: {} };
        byHeader.set(name, current);
        sections.push(current);
      }
      continue;
    }

    if (!current) continue;
    const kv = KEY_RE.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (!keep.has(key)) continue;
    // No inline-comment stripping: a `#` is legal inside an SSO start URL
    // and real configs end them that way
    // (`https://d-9067c44074.awsapps.com/start/#`). Trimming at the first
    // `#` would silently truncate the URL we display.
    current.values[key] = kv[2].trim();
  }

  return sections;
}

type Classified =
  | { kind: 'profile'; name: string; values: Record<string, string> }
  | { kind: 'sso-session'; name: string; values: Record<string, string> }
  | null;

function classify(section: AwsIniSection): Classified {
  const { header, values } = section;
  if (header === 'default') return { kind: 'profile', name: 'default', values };
  if (header.startsWith('profile ')) {
    return { kind: 'profile', name: header.slice('profile '.length).trim(), values };
  }
  if (header.startsWith('sso-session ')) {
    return { kind: 'sso-session', name: header.slice('sso-session '.length).trim(), values };
  }
  // `[services x]` and anything else we don't model.
  return null;
}

/// Section names only. `~/.aws/credentials` is all secret material below the
/// header line, so we pass an empty keep-set and never look at a value.
function credentialSectionNames(text: string): string[] {
  return parseAwsIni(text, new Set())
    .map((s) => s.header)
    .filter((n) => n.length > 0);
}

export function buildAwsAuthOverview(opts: {
  configText: string;
  credentialsText: string;
  cliPath: string | null;
  configPath: string;
}): AwsAuthOverview {
  const sections = parseAwsIni(opts.configText);
  const profiles: Array<{ name: string; values: Record<string, string> }> = [];
  const sessions = new Map<string, Record<string, string>>();

  for (const section of sections) {
    const c = classify(section);
    if (!c) continue;
    if (c.kind === 'profile') profiles.push({ name: c.name, values: c.values });
    else sessions.set(c.name, c.values);
  }

  const ssoTargets: AwsSsoTarget[] = [];
  const referencedSessions = new Set<string>();

  for (const p of profiles) {
    const ssoSession = p.values['sso_session'];
    const inlineStartUrl = p.values['sso_start_url'];
    // Modern config points at a shared `[sso-session]`; the legacy shape
    // inlines the start URL on the profile itself. Either makes it an SSO
    // profile; a profile with neither is static-key or role-based and
    // `aws sso login` would just fail on it.
    if (!ssoSession && !inlineStartUrl) continue;
    if (!isSafeAwsName(p.name)) continue;

    if (ssoSession) referencedSessions.add(ssoSession);
    const session = ssoSession ? sessions.get(ssoSession) : undefined;
    // The session block is the source of truth when the profile references
    // one; the inline keys are the legacy fallback.
    const startUrl = session?.['sso_start_url'] ?? inlineStartUrl;
    const ssoRegion = session?.['sso_region'] ?? p.values['sso_region'];
    const region = p.values['region'];
    ssoTargets.push({
      name: p.name,
      kind: 'profile',
      ...(ssoSession ? { ssoSession } : {}),
      ...(startUrl ? { startUrl } : {}),
      ...(ssoRegion ? { ssoRegion } : {}),
      ...(region ? { region } : {}),
    });
  }

  // Only orphan sessions earn a row. A session some profile already names is
  // covered by that profile's button — AWS mints one token per SSO session,
  // so a second row would log in twice to the same place.
  for (const [name, values] of sessions) {
    if (referencedSessions.has(name)) continue;
    if (!isSafeAwsName(name)) continue;
    ssoTargets.push({
      name,
      kind: 'sso-session',
      ...(values['sso_start_url'] ? { startUrl: values['sso_start_url'] } : {}),
      ...(values['sso_region'] ? { ssoRegion: values['sso_region'] } : {}),
    });
  }

  return {
    cliPath: opts.cliPath,
    configPath: opts.configPath,
    ssoTargets,
    staticProfiles: credentialSectionNames(opts.credentialsText),
  };
}

function readIfPresent(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    // Absent or unreadable is the ordinary case on a machine that has never
    // run `aws configure` — an empty overview renders the "no SSO profiles"
    // line, which is the right answer.
    return '';
  }
}

export function readAwsAuthOverview(opts?: {
  home?: string;
  cliPath?: string | null;
}): AwsAuthOverview {
  const home = opts?.home ?? os.homedir();
  // AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE are the documented
  // overrides; honour them so a user with a non-default layout sees their
  // real profiles rather than an empty panel.
  const configPath = process.env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config');
  const credentialsPath =
    process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials');

  return buildAwsAuthOverview({
    configText: readIfPresent(configPath),
    credentialsText: readIfPresent(credentialsPath),
    cliPath: opts?.cliPath ?? null,
    configPath,
  });
}
