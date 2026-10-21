import { describe, expect, it } from 'vitest';
import { pickPicture } from './pickPicture';

const worker = { name: 'Marta', job: 'Watches competitor sites for pricing and positioning changes, and reports weekly.' };

describe('picking a new worker’s picture', () => {
  it('searches for what the model names and takes the one it picks', async () => {
    const said: string[] = [];
    const url = await pickPicture(async (system, message) => {
      said.push(message);
      return system.includes('Suggest single words') ? '{"terms": ["detective", "owl"]}' : '{"pick": 1}';
    }, worker);
    expect(url).toMatch(/\/assets\/Detective\//);
    expect(said[1]).toMatch(/^The worker: Marta/);
    expect(said[1]).toContain('1. Detective');
  });

  it('tries other words when nothing on the first list suits, and gives up after two passes', async () => {
    const calls: string[] = [];
    const url = await pickPicture(async (system, message) => {
      calls.push(system.includes('Suggest single words') ? `terms:${message.includes('different words') ? 2 : 1}` : 'pick');
      if (system.includes('Suggest single words')) return message.includes('different words') ? '{"terms": ["fox"]}' : '{"terms": ["detective"]}';
      return message.includes('Fox') ? '{"pick": 1}' : '{"pick": null}';
    }, worker);
    expect(calls).toEqual(['terms:1', 'pick', 'terms:2', 'pick']);
    expect(url).toMatch(/\/assets\/Fox\//);
    expect(await pickPicture(async (s) => (s.includes('Suggest') ? '{"terms": ["owl"]}' : '{"pick": null}'), worker)).toBeNull();
  });

  it('never reuses a picture another worker has', async () => {
    const first = await pickPicture(async (s) => (s.includes('Suggest') ? '{"terms": ["owl"]}' : '{"pick": 1}'), worker);
    const second = await pickPicture(async (s) => (s.includes('Suggest') ? '{"terms": ["owl"]}' : '{"pick": 1}'), worker, [first!]);
    expect(second).not.toBe(first);
  });
});
