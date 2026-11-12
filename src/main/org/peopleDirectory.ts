// Who is who: one entry per person the org knows, with every way their name
// gets written down. Asks record whatever the asker was called at the time
// (a Slack display name, the name on a sign-in, a token named for a device),
// so the console needs the map back to the name a person goes by.

/// One person, as the console's directory lists them. Names, a handle and an
/// email only: nothing about roles, devices or spend.
export interface DirectoryPerson {
  /// Their Slack member id, or `name:<name>` for someone known only by name.
  id: string;
  name: string;
  slackUserId?: string;
  handle?: string;
  email?: string;
  /// Every other way they appear in who asked, who manages, who rated.
  aliases?: string[];
}

/// Somewhere a person was written down: a sign-in, a manager, an asker.
export interface PersonSighting {
  name?: string;
  slackUserId?: string;
  email?: string;
}

const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;
/// A mention the bridge writes when it couldn't learn a name: `<@U0…>`.
const MENTION = /^<@([UW][A-Z0-9]{6,})(?:\|[^>]*)?>$/;
/// A name given to a device rather than a person: "Sam browser", "Sam's laptop".
const DEVICE_SUFFIX = /(?:['’]s)?\s+(?:browser|laptop|desktop|phone|mobile|app|macbook|cli|token)$/i;
/// Callers that are the system, not anyone.
const NOT_PEOPLE = new Set(['overgo', 'overcli', 'everyone in the channel']);

const low = (s: string) => s.trim().toLowerCase();

/// A name worth showing: not an id, a mention or blank.
function realName(raw: string | undefined): string | undefined {
  const n = (raw ?? '').trim();
  if (!n || SLACK_ID.test(n) || MENTION.test(n) || NOT_PEOPLE.has(low(n))) return undefined;
  return n;
}

export function buildPeopleDirectory(input: { seen: readonly PersonSighting[]; slack?: ReadonlyArray<{ id: string; name: string; handle?: string }> }): DirectoryPerson[] {
  interface Acc { id: string; slackUserId?: string; slackName?: string; handle?: string; names: string[]; emails: string[] }
  const byId = new Map<string, Acc>();
  const accFor = (id: string): Acc => {
    let a = byId.get(id);
    if (!a) byId.set(id, (a = { id, slackUserId: id, names: [], emails: [] }));
    return a;
  };
  const addName = (a: Acc, n: string | undefined) => {
    if (n && !a.names.some((x) => low(x) === low(n))) a.names.push(n);
  };
  const addEmail = (a: Acc, e: string | undefined) => {
    const v = e?.trim().toLowerCase();
    if (v && v.includes('@') && !a.emails.includes(v)) a.emails.push(v);
  };
  for (const s of input.slack ?? []) {
    if (!SLACK_ID.test(s.id)) continue;
    const a = accFor(s.id);
    a.slackName = realName(s.name);
    if (s.handle?.trim()) a.handle = s.handle.trim();
  }
  const nameOnly: PersonSighting[] = [];
  for (const s of input.seen) {
    // A bare mention names the id it carries.
    const mention = s.name ? MENTION.exec(s.name.trim()) : null;
    const id = s.slackUserId && SLACK_ID.test(s.slackUserId) ? s.slackUserId : mention?.[1];
    if (!id) {
      if (realName(s.name) || s.email) nameOnly.push(s);
      continue;
    }
    const a = accFor(id);
    addName(a, realName(s.name));
    addEmail(a, s.email);
  }

  // The name a person goes by: Slack's real name, else a full name they were
  // seen under, else the first name seen. Nobody named anywhere is left out.
  const people: Array<DirectoryPerson & { keys: Set<string> }> = [];
  for (const a of byId.values()) {
    const name = a.slackName ?? a.names.find((n) => /\s/.test(n) && !DEVICE_SUFFIX.test(n)) ?? a.names.find((n) => !DEVICE_SUFFIX.test(n)) ?? a.names[0];
    if (!name) continue;
    people.push({ id: a.id, name, ...(a.slackUserId ? { slackUserId: a.slackUserId } : {}), ...(a.handle ? { handle: a.handle } : {}), ...(a.emails[0] ? { email: a.emails[0] } : {}), aliases: [...a.names, ...a.emails.slice(1)], keys: new Set() });
  }
  const index = () => {
    for (const p of people) {
      p.keys = new Set([p.name, p.handle, p.email, ...(p.aliases ?? [])].filter((x): x is string => !!x).map(low));
    }
  };
  index();

  // Someone seen without a Slack id joins the one person their name (or the
  // name before a device word, or a first name) points to; otherwise they
  // are someone of their own.
  for (const s of nameOnly) {
    const n = realName(s.name);
    const email = s.email?.trim().toLowerCase();
    const keys = [n, email].filter((x): x is string => !!x).map(low);
    if (keys.some((k) => people.some((p) => p.keys.has(k)))) {
      const p = people.find((x) => keys.some((k) => x.keys.has(k)))!;
      for (const extra of [n, email]) if (extra && !p.keys.has(low(extra))) p.aliases = [...(p.aliases ?? []), extra];
      index();
      continue;
    }
    const base = n?.replace(DEVICE_SUFFIX, '').trim();
    const matches = base
      ? people.filter((p) => p.keys.has(low(base)) || low(p.name.split(/\s+/)[0]) === low(base))
      : [];
    if (matches.length === 1) {
      matches[0].aliases = [...(matches[0].aliases ?? []), ...[n, email].filter((x): x is string => !!x)];
      index();
      continue;
    }
    const name = base || n || email!;
    people.push({ id: `name:${name}`, name, ...(email ? { email } : {}), aliases: [n, email].filter((x): x is string => !!x && low(x) !== low(name)), keys: new Set() });
    index();
  }

  return people
    .map(({ keys: _keys, aliases, ...p }) => {
      const seen = new Set([low(p.name)]);
      if (p.email) seen.add(p.email);
      const rest = (aliases ?? []).filter((x) => {
        const k = low(x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return rest.length ? { ...p, aliases: rest } : p;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
