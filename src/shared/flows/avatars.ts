// Pictures to give a worker, from DiceBear's public avatar service: PNGs at
// a stable https link, which is what Slack needs for a message's icon (it
// fetches the image itself, so a server on someone's laptop can't host one).
// Each is drawn from a random seed, so no worker's name leaves the server.

/// The kinds of drawn picture, each style public domain (CC0 on DiceBear's
/// licence page), so no credit is owed wherever a picture ends up. Styles under
/// CC BY or an artist's own terms stay out, and so do those too faint to read
/// on a dark tile. Black-and-white ones (Notionists, Lorelei) are left out too,
/// by choice: they look wrong beside the colour ones.
export const DRAWN_GROUPS = [
  { id: 'people', label: 'People', styles: ['open-peeps', 'cutouts'], words: ['people', 'person', 'human', 'face', 'colleague', 'woman', 'man'] },
  { id: 'robots', label: 'Robots', styles: ['voxel-bot', 'pixelbot'], words: ['robot', 'robots', 'bot', 'bots', 'ai', 'android', 'machine'] },
  { id: 'pixel', label: 'Pixel & voxel', styles: ['pixel-art', 'voxel-art'], words: ['pixel', 'voxel', 'retro', '8bit', 'game', 'minecraft'] },
  { id: 'playful', label: 'Playful', styles: ['moods', 'marbles', 'critters', 'clay', 'sprouts', 'thumbs', 'gaze', 'cameo'], words: ['playful', 'fun', 'cute', 'monster', 'creature', 'plant', 'mascot', 'character'] },
  { id: 'abstract', label: 'Abstract', styles: ['patchwork', 'planets', 'weave', 'landscape', 'constellation'], words: ['abstract', 'pattern', 'art', 'shape', 'planet', 'space', 'stars', 'nature', 'geometric'] },
] as const;

export const AVATAR_STYLES: readonly string[] = DRAWN_GROUPS.flatMap((g) => g.styles);

/// Initials, and the pictures saved before the styles above moved on.
const AVATAR_BASE = 'https://api.dicebear.com/9.x';
/// Pinned: a newer version could draw the same seed differently. These styles
/// aren't all in 9.x.
const DRAWN_BASE = 'https://api.dicebear.com/11.x';

export function avatarLink(style: string, seed: string): string {
  return `${DRAWN_BASE}/${style}/png?seed=${encodeURIComponent(seed)}&size=256`;
}

/// A new worker's picture until someone picks another: a pixel robot. The seed
/// is random, so each differs and no name leaves the server.
export function defaultWorkerPicture(seed: string): string {
  return avatarLink('pixelbot', seed);
}

/// The dark tile a drawn picture sits on in Slack, close to the console's own.
export const SLACK_ICON_BACKGROUND = '1f2430';

/// A picture as Slack should fetch it: Slack shows a see-through picture on
/// white, so a DiceBear one is asked for on the dark tile. One that already
/// has a colour (initials), or comes from anywhere else, stays as it is.
/// Done when posting, so what's saved and shown in the console doesn't change.
export function slackIcon(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.origin !== new URL(AVATAR_BASE).origin || u.searchParams.has('backgroundColor')) return url;
  u.searchParams.set('backgroundColor', SLACK_ICON_BACKGROUND);
  return u.toString();
}

export interface DrawnChoice {
  style: string;
  /// The PNG that gets saved, for Slack.
  url: string;
  /// The same picture as an SVG, to show in the picker: DiceBear limits how
  /// many PNGs it draws at once, and a grid of them comes back partly broken.
  preview: string;
}

function drawn(styles: readonly string[], perStyle: number, randomSeed: () => string): DrawnChoice[] {
  return styles.flatMap((style) =>
    Array.from({ length: perStyle }, () => {
      const seed = randomSeed();
      return { style, url: avatarLink(style, seed), preview: `${DRAWN_BASE}/${style}/svg?seed=${encodeURIComponent(seed)}` };
    }),
  );
}

/// A fresh batch: every style, or about thirty from one kind. An unknown kind
/// is every style.
export function avatarChoices(randomSeed: () => string, group?: string): DrawnChoice[] {
  const g = DRAWN_GROUPS.find((x) => x.id === group);
  return g ? drawn(g.styles, Math.ceil(30 / g.styles.length), randomSeed) : drawn(AVATAR_STYLES, 2, randomSeed);
}

/// Drawn pictures have no names to search, being drawn from a seed. What can
/// be searched is their kind and style: "robot" finds the robots, "cutouts"
/// that style. Nothing that fits: none.
export function drawnForSearch(query: string, randomSeed: () => string): DrawnChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const style = AVATAR_STYLES.find((x) => x === q.replace(/\s+/g, '-'));
  if (style) return drawn([style], 12, randomSeed);
  const words = q.split(/\s+/);
  const g = DRAWN_GROUPS.find((x) => x.id === q || x.label.toLowerCase() === q || words.some((w) => (x.words as readonly string[]).includes(w)));
  return g ? drawn(g.styles, Math.ceil(12 / g.styles.length), randomSeed) : [];
}

// Microsoft's Fluent Emoji, in 3D: about 1,600 polished pictures (people by
// role, animals, things) as 256px PNGs, MIT licensed, served from the repo
// at a fixed commit so a link never moves. Searched by name.
const FLUENT_BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets';

export function fluentLink(name: string, rest: string): string {
  return `${FLUENT_BASE}/${encodeURIComponent(name)}/${rest.split('/').map(encodeURIComponent).join('/')}`;
}

/// What the picker shows before anyone searches: faces that read as a
/// colleague, the tools of a technical job, then a mascot.
export const PICKS = [
  'Woman technologist', 'Man technologist', 'Technologist', 'Detective', 'Scientist', 'Woman scientist', 'Office worker', 'Woman office worker',
  'Teacher', 'Judge', 'Artist', 'Ninja', 'Astronaut', 'Mechanic', 'Cook', 'Health worker', 'Student', 'Pilot', 'Construction worker', 'Guard',
  // Technical work: code, data, testing, security, ops.
  'Robot', 'Laptop', 'Desktop computer', 'Keyboard', 'Gear', 'Mechanical arm', 'Satellite antenna', 'Satellite', 'Electric plug', 'Battery',
  'Magnifying glass tilted right', 'Bug', 'Test tube', 'Microscope', 'Telescope', 'Shield', 'Locked with key', 'Bar chart', 'Chart increasing', 'Puzzle piece',
  'Owl', 'Fox', 'Cat face', 'Lion', 'Unicorn', 'Bear', 'Panda', 'Koala', 'Tiger face', 'Penguin', 'Octopus', 'Dog face', 'Rabbit face',
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

/// Words people search for that no Fluent picture is named after: the
/// pictures that stand for them, shown first.
export const ALSO = new Map<string, string[]>([
  ['server', ['Desktop computer', 'Satellite antenna', 'Card file box', 'Electric plug']],
  ['servers', ['Desktop computer', 'Satellite antenna', 'Card file box', 'Electric plug']],
  ['database', ['Card file box', 'Floppy disk', 'Computer disk', 'File cabinet']],
  ['db', ['Card file box', 'Floppy disk', 'Computer disk', 'File cabinet']],
  ['data', ['Bar chart', 'Chart increasing', 'Card file box', 'Abacus']],
  ['analyst', ['Bar chart', 'Chart increasing', 'Abacus', 'Magnifying glass tilted right']],
  ['analytics', ['Bar chart', 'Chart increasing', 'Abacus']],
  ['code', ['Technologist', 'Laptop', 'Keyboard', 'Desktop computer']],
  ['coder', ['Technologist', 'Laptop', 'Keyboard']],
  ['developer', ['Technologist', 'Laptop', 'Keyboard', 'Hammer and wrench']],
  ['dev', ['Technologist', 'Laptop', 'Keyboard']],
  ['engineer', ['Technologist', 'Mechanic', 'Gear', 'Hammer and wrench']],
  ['computer', ['Laptop', 'Desktop computer', 'Keyboard']],
  ['ai', ['Robot', 'Brain', 'Mechanical arm', 'Crystal ball']],
  ['bot', ['Robot', 'Mechanical arm']],
  ['qa', ['Bug', 'Test tube', 'Magnifying glass tilted right', 'Microscope']],
  ['test', ['Test tube', 'Bug', 'Microscope']],
  ['tester', ['Test tube', 'Bug', 'Magnifying glass tilted right']],
  ['security', ['Shield', 'Locked with key', 'Key', 'Guard']],
  ['ops', ['Gear', 'Satellite antenna', 'Hammer and wrench', 'Electric plug']],
  ['devops', ['Gear', 'Satellite antenna', 'Hammer and wrench']],
  ['infra', ['Satellite antenna', 'Gear', 'Electric plug', 'Desktop computer']],
  ['cloud', ['Cloud', 'Satellite', 'Satellite antenna']],
  ['network', ['Satellite antenna', 'Antenna bars', 'Globe with meridians']],
  ['support', ['Office worker', 'Telephone receiver', 'Speech balloon']],
  ['research', ['Microscope', 'Telescope', 'Magnifying glass tilted right', 'Scientist']],
  ['docs', ['Spiral notepad', 'Clipboard', 'Books']],
  ['writer', ['Spiral notepad', 'Writing hand', 'Fountain pen']],
]);

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
  const also = (ALSO.get(q) ?? []).filter((n) => byName.has(n));
  const found = index
    .filter(([n]) => !also.includes(n) && words.every((w) => n.toLowerCase().includes(w)))
    .map(([n, rest, toned]) => ({ n, rest: inTone(rest, !!toned, tone), r: rank(n) }))
    .sort((a, b) => a.r - b.r || a.n.length - b.n.length || a.n.localeCompare(b.n))
    .map(({ n, rest }) => ({ name: n, url: fluentLink(n, rest) }));
  return [...also.map((n) => ({ name: n, url: fluentLink(n, byName.get(n)!) })), ...found].slice(0, limit);
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
