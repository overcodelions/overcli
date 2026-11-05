import { describe, expect, it } from 'vitest';
import { ALSO, AVATAR_STYLES, DRAWN_GROUPS, PICKS, SLACK_ICON_BACKGROUND, avatarChoices, avatarLink, drawnForSearch, initialsPicture, searchPictures, slackIcon } from './avatars';
import { FLUENT_EMOJI } from './fluentEmoji';

describe('worker pictures', () => {
  it('draws people in every style, each from its own seed', () => {
    let n = 0;
    const choices = avatarChoices(() => `seed${++n}`);
    expect(choices).toHaveLength(AVATAR_STYLES.length * 2);
    expect(new Set(choices.map((c) => c.url)).size).toBe(choices.length);
    expect(choices.every((c) => /^https:\/\/api\.dicebear\.com\/11\.x\/[a-z-]+\/png\?seed=seed\d+&size=256$/.test(c.url))).toBe(true);
    expect(avatarLink('lorelei', 'a b')).toBe('https://api.dicebear.com/11.x/lorelei/png?seed=a%20b&size=256');
  });

  it('finds Fluent pictures by name, the closest first, at a pinned commit', () => {
    const owls = searchPictures(FLUENT_EMOJI, 'owl');
    expect(owls[0]).toEqual({ name: 'Owl', url: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Owl/3D/owl_3d.png' });
    expect(searchPictures(FLUENT_EMOJI, 'woman detective').map((p) => p.name)).toEqual(['Woman detective']);
    expect(searchPictures(FLUENT_EMOJI, 'zzzz')).toEqual([]);
    expect(searchPictures(FLUENT_EMOJI, '').map((p) => p.name)).toContain('Woman technologist');
  });

  it('draws people in the skin tone picked, and leaves things as they are', () => {
    const [tech] = searchPictures(FLUENT_EMOJI, 'woman technologist', 48, 'Medium-Dark');
    expect(tech.url).toMatch(/\/Woman%20technologist\/Medium-Dark\/3D\/woman_technologist_3d_medium-dark\.png$/);
    expect(searchPictures(FLUENT_EMOJI, 'owl', 48, 'Dark')[0].url).toMatch(/\/Owl\/3D\/owl_3d\.png$/);
  });

  it('gives a worker without a picture an initials tile in its console colour, sending only the letters', () => {
    const url = initialsPicture('w-1', 'Marta Lopez');
    expect(url).toMatch(/^https:\/\/api\.dicebear\.com\/9\.x\/initials\/png\?seed=ML&backgroundColor=[0-9a-f]{6}&textColor=ffffff&size=256$/);
    expect(url).not.toContain('Marta');
    expect(initialsPicture('w-1', 'Marta Lopez')).toBe(url);
    expect(initialsPicture('w-2', 'Marta Lopez')).not.toBe(url);
  });
});

describe('the pictures shown before a search', () => {
  it('are all real Fluent pictures, each once, with technical ones among them', () => {
    const names = new Set(FLUENT_EMOJI.map(([n]) => n));
    expect(PICKS.filter((n) => !names.has(n))).toEqual([]);
    expect(new Set(PICKS).size).toBe(PICKS.length);
    const shown = searchPictures(FLUENT_EMOJI, '').map((p) => p.name);
    expect(shown).toHaveLength(PICKS.length);
    expect(shown).toEqual(expect.arrayContaining(['Laptop', 'Bug', 'Shield', 'Bar chart', 'Robot']));
  });
});

describe('searching for a technical word no picture is named after', () => {
  it('finds the pictures that stand for it, first', () => {
    expect(searchPictures(FLUENT_EMOJI, 'server').map((p) => p.name).slice(0, 2)).toEqual(['Desktop computer', 'Satellite antenna']);
    expect(searchPictures(FLUENT_EMOJI, ' QA ').map((p) => p.name)[0]).toBe('Bug');
    // Stood-for pictures come first, the name matches after, none twice.
    const data = searchPictures(FLUENT_EMOJI, 'data').map((p) => p.name);
    expect(data[0]).toBe('Bar chart');
    expect(new Set(data).size).toBe(data.length);
  });

  it('only names pictures that exist, so each word finds something', () => {
    const names = new Set(FLUENT_EMOJI.map(([n]) => n));
    for (const [word, pics] of ALSO) {
      expect([word, pics.filter((n) => !names.has(n))]).toEqual([word, []]);
      expect(searchPictures(FLUENT_EMOJI, word).length).toBeGreaterThan(0);
    }
  });
});

describe('drawn people in the picker', () => {
  it('shows an SVG of the same picture, and saves the PNG Slack needs', () => {
    let n = 0;
    for (const c of avatarChoices(() => `seed${++n}`)) {
      expect(c.url).toBe(avatarLink(c.style, new URL(c.url).searchParams.get('seed')!));
      expect(new URL(c.url).pathname).toMatch(/\/png$/);
      expect(new URL(c.preview).pathname).toBe(new URL(c.url).pathname.replace(/\/png$/, '/svg'));
      expect(new URL(c.preview).searchParams.get('seed')).toBe(new URL(c.url).searchParams.get('seed'));
    }
  });
});

describe('a picture as Slack gets it', () => {
  it('puts a drawn picture on the dark tile, keeping the same picture', () => {
    const dark = new URL(slackIcon(avatarLink('notionists', 'abc')));
    expect(dark.pathname).toBe('/11.x/notionists/png');
    expect(dark.searchParams.get('seed')).toBe('abc');
    expect(dark.searchParams.get('size')).toBe('256');
    expect(dark.searchParams.get('backgroundColor')).toBe(SLACK_ICON_BACKGROUND);
  });

  it('leaves initials, which have their own colour, and every other picture alone', () => {
    const initials = initialsPicture('w1', 'Sam Lane');
    expect(slackIcon(initials)).toBe(initials);
    const fluent = searchPictures(FLUENT_EMOJI, 'owl')[0].url;
    expect(slackIcon(fluent)).toBe(fluent);
    expect(slackIcon('https://img.acme.example/me.png?x=1')).toBe('https://img.acme.example/me.png?x=1');
    expect(slackIcon('not a link')).toBe('not a link');
  });
});

describe('the kinds of drawn picture', () => {
  // On DiceBear's licence page: CC BY needs credit, the artist's terms need reading.
  const CREDIT_OR_OWN_TERMS = ['adventurer', 'adventurer-neutral', 'big-ears', 'big-ears-neutral', 'big-smile', 'croodles', 'croodles-neutral', 'dylan', 'fun-emoji', 'glyphs', 'micah', 'miniavs', 'personas', 'toon-head', 'avataaars', 'avataaars-neutral', 'bottts', 'bottts-neutral', 'icons'];

  it('offers only public-domain styles, each in one kind', () => {
    expect(AVATAR_STYLES.filter((s) => CREDIT_OR_OWN_TERMS.includes(s))).toEqual([]);
    expect(AVATAR_STYLES).not.toContain('notionists');
    expect(AVATAR_STYLES).not.toContain('lorelei');
    expect(new Set(AVATAR_STYLES).size).toBe(AVATAR_STYLES.length);
  });

  it('draws from the one kind asked for, and from all for one it doesn’t know', () => {
    let n = 0;
    const seed = () => `s${++n}`;
    const robots = avatarChoices(seed, 'robots');
    expect(new Set(robots.map((c) => c.style))).toEqual(new Set(['voxel-bot', 'pixelbot']));
    expect(robots).toHaveLength(30);
    expect(avatarChoices(seed, 'nope')).toHaveLength(AVATAR_STYLES.length * 2);
    expect(avatarChoices(seed, 'constructor')).toHaveLength(AVATAR_STYLES.length * 2);
  });

  it('is found by searching a kind or a style, not by subject', () => {
    let n = 0;
    const seed = () => `s${++n}`;
    expect(new Set(drawnForSearch('Robot', seed).map((c) => c.style))).toEqual(new Set(['voxel-bot', 'pixelbot']));
    expect(new Set(drawnForSearch('pixel', seed).map((c) => c.style))).toEqual(new Set(['pixel-art', 'voxel-art']));
    expect(new Set(drawnForSearch('open peeps', seed).map((c) => c.style))).toEqual(new Set(['open-peeps']));
    expect(drawnForSearch('scientist', seed)).toEqual([]);
    expect(drawnForSearch('  ', seed)).toEqual([]);
    for (const g of DRAWN_GROUPS) expect(drawnForSearch(g.label, seed).length).toBeGreaterThan(0);
  });
});
