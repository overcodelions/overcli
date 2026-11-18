// Claude on Bedrock for workers, without the server's role in their reach.
//
// A worker's `claude` runs as the worker user, which can no longer reach the
// server's cloud role (workerCloud.ts). It still needs the model. Claude Code
// can send its Bedrock calls to a gateway and skip signing them itself
// (ANTHROPIC_BEDROCK_BASE_URL with CLAUDE_CODE_SKIP_BEDROCK_AUTH=1): this is
// that gateway, on loopback in the server. It signs with the server's role and
// forwards to Bedrock runtime, and it forwards model calls only. Nothing else
// the role may do is reachable through it.
//
// Anything on the box can call it, workers included: the same model calls
// their own `claude` makes for them anyway.

import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';

export interface BedrockSigner {
  /// The headers to send, signed for `hostname` + `path` with `body`.
  sign(req: { method: string; hostname: string; path: string; headers: Record<string, string>; body: Buffer }): Promise<Record<string, string>>;
}

export interface Upstream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

export interface BedrockProxyDeps {
  region: string;
  signer: BedrockSigner;
  log(message: string): void;
  /// The request to Bedrock; tests replace it.
  send?(url: URL, headers: Record<string, string>, body: Buffer): Promise<Upstream>;
}

const ACTIONS = new Set(['invoke', 'invoke-with-response-stream', 'converse', 'converse-stream', 'count-tokens']);
const MAX_BODY = 32 * 1024 * 1024;

/// The Bedrock runtime path a request may go to, normalised the way the
/// SDK encodes it, or null when it is not a model call.
export function bedrockPath(raw: string): string | null {
  const [p, query] = raw.split('?');
  if (query) return null;
  const m = /^\/model\/([^/]+)\/([a-z-]+)$/.exec(p);
  if (!m || !ACTIONS.has(m[2])) return null;
  let model: string;
  try {
    model = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!model || model.length > 2048 || /[\s\0]/.test(model)) return null;
  return `/model/${encodeURIComponent(model)}/${m[2]}`;
}

/// The headers worth passing on from Claude Code to Bedrock.
function passOn(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    if (k === 'content-type' || k === 'accept' || k.startsWith('x-amzn-bedrock-')) out[k] = v;
  }
  return out;
}

function sendHttps(url: URL, headers: Record<string, string>, body: Buffer): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res }));
    req.on('error', reject);
    req.end(body);
  });
}

export class BedrockProxy {
  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly deps: BedrockProxyDeps) {}

  get hostname(): string {
    return `bedrock-runtime.${this.deps.region}.amazonaws.com`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /// What a `claude` process needs to think through this proxy.
  env(): Record<string, string> {
    if (!this.server) return {};
    return { ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${this.port}`, CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message }));
    };
    const target = req.method === 'POST' ? bedrockPath(req.url ?? '') : null;
    if (!target) return fail(403, 'This gateway forwards Bedrock model calls only.');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return fail(413, 'Request too large.');
        chunks.push(chunk as Buffer);
      }
    } catch {
      return fail(400, 'Could not read the request.');
    }
    const body = Buffer.concat(chunks);
    let up: Upstream;
    try {
      const headers = await this.deps.signer.sign({ method: 'POST', hostname: this.hostname, path: target, headers: passOn(req.headers), body });
      up = await (this.deps.send ?? sendHttps)(new URL(`https://${this.hostname}${target}`), headers, body);
    } catch (err) {
      this.deps.log(`bedrock-proxy: ${err instanceof Error ? err.message : String(err)}`);
      return fail(502, `Could not reach Bedrock: ${err instanceof Error ? err.message : String(err)}`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (typeof v === 'string' && (k === 'content-type' || k.startsWith('x-amzn-'))) out[k] = v;
    }
    res.writeHead(up.status, out);
    up.body.pipe(res);
    up.body.on('error', () => res.destroy());
    res.on('close', () => up.body.destroy());
  }
}
