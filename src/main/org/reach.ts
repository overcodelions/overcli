// Can the internet reach this console? A webhook trigger hands Jira, GitHub
// or a CRM an address to post to, and those post from the internet: a
// console inside a VPC, even on a proper https name, never hears them. The
// browser can't tell (it's on the VPN), so the server looks up its own
// public address and says whether it only resolves to private ones.
//
// It is a hint, not a test: a public address behind a firewall still looks
// public, and a split-horizon name may look private from in here.

import dns from 'node:dns';
import net from 'node:net';

export interface Reach {
  host: string;
  /// Only private addresses, or a name only a private network uses.
  private: boolean;
}

/// RFC 1918, loopback, link-local, CGNAT (VPNs like Tailscale use it), and
/// their IPv6 kin.
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!net.isIPv6(ip)) return false;
  const first = ip.toLowerCase();
  return first === '::1' || first === '::' || /^f[cd][0-9a-f]{2}:/.test(first) || /^fe[89ab][0-9a-f]:/.test(first);
}

/// Names only a private network resolves: no dot, or a suffix kept for it.
const PRIVATE_NAME = /(^[^.]+$)|\.(internal|local|lan|corp|intranet|home\.arpa|localdomain)$/i;

export async function reachOf(base: string, lookup: (host: string) => Promise<string[]> = defaultLookup): Promise<Reach> {
  let host: string;
  try {
    host = new URL(base).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { host: base, private: false };
  }
  if (net.isIP(host)) return { host, private: isPrivateAddress(host) };
  if (PRIVATE_NAME.test(host)) return { host, private: true };
  try {
    const ips = await lookup(host);
    return { host, private: ips.length > 0 && ips.every(isPrivateAddress) };
  } catch {
    return { host, private: false };
  }
}

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dns.promises.lookup(host, { all: true });
  return found.map((a) => a.address);
}
