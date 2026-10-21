// Pictures to give a worker, from DiceBear's public avatar service: PNGs at
// a stable https link, which is what Slack needs for a message's icon (it
// fetches the image itself, so a server on someone's laptop can't host one).
// Each is drawn from a random seed, so no worker's name leaves the server.

/// People, drawn: faces that read as a colleague rather than a mascot.
export const AVATAR_STYLES = ['avataaars', 'personas', 'micah', 'notionists', 'lorelei', 'adventurer', 'open-peeps', 'big-smile'] as const;

const AVATAR_BASE = 'https://api.dicebear.com/9.x';

export function avatarLink(style: string, seed: string): string {
  return `${AVATAR_BASE}/${style}/png?seed=${encodeURIComponent(seed)}&size=256`;
}

/// `perStyle` choices in every style, each from a fresh seed.
export function avatarChoices(randomSeed: () => string, perStyle = 2): Array<{ style: string; url: string }> {
  return AVATAR_STYLES.flatMap((style) => Array.from({ length: perStyle }, () => ({ style, url: avatarLink(style, randomSeed()) })));
}

// Microsoft's Fluent Emoji, in 3D: about 1,600 polished pictures (people by
// role, animals, things) as 256px PNGs, MIT licensed, served from the repo
// at a fixed commit so a link never moves. Searched by name.
const FLUENT_BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets';

export function fluentLink(name: string, rest: string): string {
  return `${FLUENT_BASE}/${encodeURIComponent(name)}/${rest.split('/').map(encodeURIComponent).join('/')}`;
}

/// What the picker shows before anyone searches: faces that read as a
/// colleague, a mascot or a role.
const PICKS = [
  'Woman technologist', 'Man technologist', 'Technologist', 'Detective', 'Scientist', 'Woman scientist', 'Office worker', 'Woman office worker',
  'Teacher', 'Judge', 'Artist', 'Ninja', 'Astronaut', 'Mechanic', 'Cook', 'Health worker', 'Student', 'Pilot', 'Construction worker', 'Guard',
  'Owl', 'Fox', 'Robot', 'Cat face', 'Lion', 'Unicorn', 'Bear', 'Panda', 'Koala', 'Tiger face', 'Penguin', 'Octopus', 'Dog face', 'Rabbit face',
  'Frog', 'Monkey face', 'Wolf', 'Alien', 'Ghost', 'Rocket', 'Crystal ball', 'Light bulb', 'Brain',
];

/// The skin tones Fluent draws its people in, besides the default yellow.
export const PICTURE_TONES = ['Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'] as const;
export type PictureTone = (typeof PICTURE_TONES)[number];

type FluentIndex = ReadonlyArray<readonly [string, string, 1?]>;

/// A picture's path in a tone, for one that comes in tones.
function inTone(rest: string, toned: boolean, tone?: PictureTone): string {
  return toned && tone ? rest.replace('Default/', `${tone}/`).replace(/_default\.png$/, `_${tone.toLowerCase()}.png`) : rest;
}

/// Fluent pictures whose name has every word searched for: the whole name
/// first, then names starting with it, then a word starting with it, and
/// shorter names before longer. No search: the picks. People in `tone`.
export function searchPictures(index: FluentIndex, query: string, limit = 48, tone?: PictureTone): Array<{ name: string; url: string }> {
  const q = query.trim().toLowerCase();
  const byName = new Map(index.map(([n, rest, toned]) => [n, inTone(rest, !!toned, tone)]));
  if (!q) return PICKS.flatMap((n) => (byName.has(n) ? [{ name: n, url: fluentLink(n, byName.get(n)!) }] : []));
  const words = q.split(/\s+/).filter(Boolean);
  const rank = (name: string): number => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    return n.split(/[\s:-]+/).some((w) => w.startsWith(words[0])) ? 2 : 3;
  };
  return index
    .filter(([n]) => words.every((w) => n.toLowerCase().includes(w)))
    .map(([n, rest, toned]) => ({ n, rest: inTone(rest, !!toned, tone), r: rank(n) }))
    .sort((a, b) => a.r - b.r || a.n.length - b.n.length || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map(({ n, rest }) => ({ name: n, url: fluentLink(n, rest) }));
}

/// What a worker or team posts under in Slack when nobody picked a picture:
/// its initials on the colour the console draws them on, so each is told
/// apart at a glance. Only the initials leave the server.
export function initialsPicture(id: string, name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  return `${AVATAR_BASE}/initials/png?seed=${encodeURIComponent(letters)}&backgroundColor=${hslHex(hue(id + name), 0.42, 0.4)}&textColor=ffffff&size=256`;
}

// The console's colour for an id and name (FNV-1a, so ids a few characters
// apart still land far apart), as hex.
function hue(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0) % 360;
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `${f(0)}${f(8)}${f(4)}`;
}
