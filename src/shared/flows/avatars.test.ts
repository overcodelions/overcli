import { describe, expect, it } from 'vitest';
import { AVATAR_STYLES, avatarChoices, avatarLink, initialsPicture, searchPictures } from './avatars';
import { FLUENT_EMOJI } from './fluentEmoji';

describe('worker pictures', () => {
  it('draws people in every style, each from its own seed', () => {
    let n = 0;
    const choices = avatarChoices(() => `seed${++n}`);
    expect(choices).toHaveLength(AVATAR_STYLES.length * 2);
    expect(new Set(choices.map((c) => c.url)).size).toBe(choices.length);
    expect(choices.every((c) => /^https:\/\/api\.dicebear\.com\/9\.x\/[a-z-]+\/png\?seed=seed\d+&size=256$/.test(c.url))).toBe(true);
    expect(avatarLink('micah', 'a b')).toBe('https://api.dicebear.com/9.x/micah/png?seed=a%20b&size=256');
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
