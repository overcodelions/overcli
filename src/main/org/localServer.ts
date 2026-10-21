// "Try it on this Mac": the org server, run by the app itself.
//
// The app already ships the CLI (dist/cli), so rather than hand someone a
// clone-and-build recipe, it starts `overcli serve` with its own Node
// (Electron run as Node) against a state folder of its own, separate from
// this app's workers. What the server prints tells us where the console is
// and, on its very first start, the one-time link that signs in the first
// admin — printed once, so it is kept here until it has been used.
//
// It runs only while the app is open: it is a way to try the org setup, not
// a server for a team.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { LocalOrgServerStatus } from '../../shared/types';

const FIRST_PORT = 7420;
const LOG_LINES = 80;

export class LocalOrgServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private starting = false;
  private log: string[] = [];

  constructor(
    private readonly stateDir = path.join(os.homedir(), 'overcli-org'),
    private readonly memoPath = path.join(app.getPath('userData'), 'local-org-server.json'),
  ) {}

  status(): LocalOrgServerStatus {
    return {
      running: !!this.child && !this.starting && !!this.url,
      starting: this.starting,
      url: this.url,
      firstAdminLink: this.memo().firstAdminLink ?? null,
      stateDir: this.stateDir,
      error: this.error,
      log: this.log.slice(-LOG_LINES),
    };
  }

  /// Start it, and resolve once the console is listening (or it failed).
  async start(): Promise<LocalOrgServerStatus> {
    if (this.child) return this.status();
    this.error = null;
    this.starting = true;
    this.log = [];
    const cli = path.join(app.getAppPath(), 'dist', 'cli', 'index.js');
    if (!fs.existsSync(cli)) {
      this.starting = false;
      this.error = 'This build of overcli has no server in it. Build it with npm run build:main.';
      return this.status();
    }
    fs.mkdirSync(this.stateDir, { recursive: true });
    const port = await freePort(FIRST_PORT);
    // The same tool policy deploy/docker-compose.yml gives a real server, so a
    // worker tried here behaves as it will there: reading, writing in its
    // folder and the web, and nothing that acts outside without a person.
    const args = [cli, 'serve', '--state-dir', this.stateDir, '--control', `127.0.0.1:${port}`,
      '--permissions', 'allow-list', '--allow-tool', 'Read,Glob,Grep,Edit,Write,WebSearch,WebFetch'];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.starting = false;
        resolve(this.status());
      };
      let partial = '';
      const read = (chunk: Buffer) => {
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trimEnd();
          if (!text) continue;
          this.log.push(text);
          if (this.log.length > LOG_LINES * 2) this.log.splice(0, this.log.length - LOG_LINES);
          const at = /^control: (http:\/\/\S+?)\/? \(console\)/.exec(text);
          if (at) {
            this.url = at[1];
            // The first-admin line follows within a moment, when there is one.
            setTimeout(done, 800);
          }
          const link = /first admin: (\S+)$/.exec(text);
          if (link) {
            this.saveMemo({ firstAdminLink: link[1] });
            done();
          }
          const failed = /^control: could not listen on .*? — (.*)$/.exec(text);
          if (failed) {
            this.error = failed[1];
            child.kill();
          }
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('exit', (code) => {
        if (this.child === child) this.child = null;
        this.url = null;
        if (!settled) this.error = this.error ?? `The server stopped before it was ready (exit ${code ?? 'signal'}).`;
        done();
      });
      child.on('error', (err) => {
        this.error = err.message;
        done();
      });
      setTimeout(() => {
        if (!settled) {
          this.error = 'The server took too long to start.';
          child.kill();
          if (this.child === child) this.child = null;
        }
        done();
      }, 30_000);
    });
  }

  stop(): LocalOrgServerStatus {
    this.child?.kill();
    this.child = null;
    this.url = null;
    return this.status();
  }

  /// The first-admin link only works once: forget it after it has been opened.
  forgetFirstAdminLink(): void {
    this.saveMemo({ firstAdminLink: undefined });
  }

  private memo(): { firstAdminLink?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.memoPath, 'utf8')) as { firstAdminLink?: string };
    } catch {
      return {};
    }
  }

  private saveMemo(patch: { firstAdminLink?: string }): void {
    const next = { ...this.memo(), ...patch };
    try {
      fs.writeFileSync(this.memoPath, JSON.stringify(next), { mode: 0o600 });
    } catch {
      // Not worth failing the start over.
    }
  }
}

/// The first port from `from` that nothing is listening on, so a server
/// someone already runs on 7420 isn't fought over.
function freePort(from: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number) => {
      const probe = net.createServer();
      probe.once('error', () => (port < from + 20 ? tryPort(port + 1) : resolve(from)));
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    tryPort(from);
  });
}
