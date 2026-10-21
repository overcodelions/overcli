import { describe, expect, it } from 'vitest';
import { isPrivateAddress, reachOf } from './reach';

describe('whether the internet can reach the console', () => {
  it('knows private addresses from public ones', () => {
    for (const ip of ['10.0.4.2', '172.20.1.1', '192.168.1.9', '127.0.0.1', '169.254.0.1', '100.101.2.3', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.1.2.3']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('calls an https name private when it only resolves to private addresses', async () => {
    expect(await reachOf('https://overgo.acme.example', async () => ['10.2.3.4'])).toEqual({ host: 'overgo.acme.example', private: true });
    expect(await reachOf('https://overgo.acme.example', async () => ['10.2.3.4', '52.1.2.3'])).toEqual({ host: 'overgo.acme.example', private: false });
  });

  it('knows private names and addresses without a lookup', async () => {
    const never = async (): Promise<string[]> => {
      throw new Error('no lookup');
    };
    expect((await reachOf('https://overgo.internal', never)).private).toBe(true);
    expect((await reachOf('http://overgo:7420', never)).private).toBe(true);
    expect((await reachOf('http://10.0.0.5:7420', never)).private).toBe(true);
    expect((await reachOf('https://overgo.acme.example', never)).private).toBe(false);
  });
});
