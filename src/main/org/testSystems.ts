// Setup → Apps to test: the apps workers QA, kept in org/test-systems.json,
// and their test accounts, kept in the test-systems tool's env, which the
// server seals (toolEnvVault.ts) like every command tool's. Saving an app
// (re)installs the tool so its env holds exactly the credentials of the apps
// that remain. Nothing here hands a credential back: the console sees only
// whether each is set.

import path from 'node:path';

import { TEST_SYSTEMS_TOOL, TEST_SYSTEMS_VERSION, credentialEnv, extraEnv, extraEnvPrefix, parseTestSystem, slugify, systemEnvNames, type TestSystem, type TestSystemsFile } from '../../shared/testSystems';
import type { OrgCaller } from '../../shared/org/policy';
import type { ToolInput } from './tools';
import { base32Decode } from './totp';
import type { Discovered } from './testSystemsDiscover';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/// The last Test from Setup → Apps to test, kept until the server restarts.
export interface LastTest {
  at: number;
  ok: boolean;
  ms: number;
  environment?: string;
  text: string;
}

export interface TestSystemView extends TestSystem {
  lastTest?: LastTest;
  has: { user: boolean; password: boolean; code: boolean; key: boolean; extra: Record<string, boolean> };
}

export interface TestSystemsDeps {
  load(): TestSystemsFile;
  save(file: TestSystemsFile): void;
  /// org/test-systems.json, which the tool reads at every open.
  file(): string;
  isAdmin(caller: OrgCaller): boolean;
  tools: {
    install(input: ToolInput): { ok: true } | { ok: false; error: string };
    uninstall(name: string): unknown;
    /// The tool's env as it is now (with the gateway on, from the vault).
    env(): Record<string, string>;
  };
  /// The compiled testSystemsServer.js.
  serverScript(): string;
  /// Open an app as a worker would (testSystemsServer.ts checkSystem).
  check?(system: TestSystem, environment: string | undefined, secrets: Record<string, string>): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  /// Read an app's login form from its address (testSystemsServer.ts discoverSystem).
  discover?(address: string, username?: string): Promise<{ ok: true; found: Discovered } | { ok: false; error: string }>;
  record?(caller: OrgCaller, what: string): void;
}

const CREDENTIALS = ['user', 'password', 'code', 'key'] as const;

export class TestSystemsService {
  private readonly lastTests = new Map<string, LastTest>();

  constructor(private readonly deps: TestSystemsDeps) {}

  private denied(caller: OrgCaller): { ok: false; error: string } | null {
    return this.deps.isAdmin(caller) ? null : { ok: false, error: 'Only admins can set up apps to test.' };
  }

  private view(s: TestSystem, env: Record<string, string>): TestSystemView {
    const e = credentialEnv(s.id);
    const secretExtras = s.signIn.kind === 'form' ? (s.signIn.extra ?? []).filter((x) => x.secret) : [];
    const last = this.lastTests.get(s.id);
    return {
      ...s,
      ...(last ? { lastTest: last } : {}),
      has: { user: !!env[e.user], password: !!env[e.password], code: !!env[e.code], key: !!env[e.key], extra: Object.fromEntries(secretExtras.map((x) => [x.key, !!env[extraEnv(s.id, x.key)]])) },
    };
  }

  list(caller: OrgCaller): Result<{ systems: TestSystemView[]; tool: string }> {
    const no = this.denied(caller);
    if (no) return no;
    const env = this.deps.tools.env();
    return { ok: true, systems: this.deps.load().systems.map((s) => this.view(s, env)), tool: TEST_SYSTEMS_TOOL };
  }

  /// Add or change one. `credentials`: a value sets it, an empty string
  /// clears it, absent keeps what's there. `credentials.extra` holds secret
  /// extra fields' values by the field's name.
  save(caller: OrgCaller, input: { system?: unknown; credentials?: unknown; previousId?: unknown }): Result<{ system: TestSystemView }> {
    const no = this.denied(caller);
    if (no) return no;
    const parsed = parseTestSystem(input.system);
    if (!parsed.ok) return parsed;
    const system = parsed.system;
    const file = this.deps.load();
    const previousId = typeof input.previousId === 'string' && input.previousId ? input.previousId : system.id;
    if (previousId !== system.id && file.systems.some((s) => s.id === system.id)) return { ok: false, error: `Another app is already called ${system.name}.` };
    const env = { ...this.deps.tools.env() };
    // A renamed app keeps its credentials under its new id.
    if (previousId !== system.id) {
      const from = credentialEnv(previousId);
      const to = credentialEnv(system.id);
      for (const k of CREDENTIALS) {
        if (env[from[k]] !== undefined) env[to[k]] = env[from[k]];
        delete env[from[k]];
      }
      const fromX = extraEnvPrefix(previousId);
      const toX = extraEnvPrefix(system.id);
      for (const k of Object.keys(env)) {
        if (!k.startsWith(fromX)) continue;
        env[`${toX}${k.slice(fromX.length)}`] = env[k];
        delete env[k];
      }
    }
    const given = input.credentials && typeof input.credentials === 'object' ? (input.credentials as Record<string, unknown>) : {};
    const names = credentialEnv(system.id);
    for (const k of CREDENTIALS) {
      const v = given[k];
      if (typeof v !== 'string') continue;
      if (v.trim()) env[names[k]] = v.trim();
      else delete env[names[k]];
    }
    const extraGiven = given.extra && typeof given.extra === 'object' ? (given.extra as Record<string, unknown>) : {};
    for (const [label, v] of Object.entries(extraGiven)) {
      const key = slugify(label, 20);
      if (!key || typeof v !== 'string') continue;
      if (v.trim()) env[extraEnv(system.id, key)] = v.trim();
      else delete env[extraEnv(system.id, key)];
    }
    // Checked now, not at the first sign-in that needs it.
    if (env[names.code]) {
      try {
        if (!base32Decode(env[names.code]).length) throw new Error('empty');
      } catch {
        return { ok: false, error: 'The authenticator secret is the base32 text an authenticator app is given: letters A–Z and digits 2–7.' };
      }
    }
    if (previousId !== system.id) {
      const last = this.lastTests.get(previousId);
      this.lastTests.delete(previousId);
      if (last) this.lastTests.set(system.id, last);
    }
    const systems = [...file.systems.filter((s) => s.id !== previousId && s.id !== system.id), system].sort((a, b) => a.name.localeCompare(b.name));
    const installed = this.install(systems, env);
    if (!installed.ok) return installed;
    this.deps.save({ version: TEST_SYSTEMS_VERSION, systems });
    this.deps.record?.(caller, `${file.systems.some((s) => s.id === previousId) ? 'Changed' : 'Added'} the app to test ${system.name}.`);
    return { ok: true, system: this.view(system, env) };
  }

  remove(caller: OrgCaller, id: string): Result {
    const no = this.denied(caller);
    if (no) return no;
    const file = this.deps.load();
    const gone = file.systems.find((s) => s.id === id);
    if (!gone) return { ok: false, error: 'No such app.' };
    const systems = file.systems.filter((s) => s.id !== id);
    if (systems.length) {
      const installed = this.install(systems, this.deps.tools.env());
      if (!installed.ok) return installed;
    } else {
      this.deps.tools.uninstall(TEST_SYSTEMS_TOOL);
    }
    this.deps.save({ version: TEST_SYSTEMS_VERSION, systems });
    this.lastTests.delete(id);
    this.deps.record?.(caller, `Removed the app to test ${gone.name}.`);
    return { ok: true };
  }

  async test(caller: OrgCaller, id: string, environment?: string): Promise<{ ok: true; detail: string; lastTest: LastTest } | { ok: false; error: string; lastTest?: LastTest }> {
    const no = this.denied(caller);
    if (no) return no;
    const system = this.deps.load().systems.find((s) => s.id === id);
    if (!system) return { ok: false, error: 'No such app.' };
    if (!this.deps.check) return { ok: false, error: 'This server can’t open a browser to check.' };
    const env = environment?.trim() || undefined;
    const started = Date.now();
    const res = await this.deps.check(system, env, this.deps.tools.env());
    const at = Date.now();
    const lastTest: LastTest = { at, ok: res.ok, ms: at - started, ...(env ? { environment: env } : {}), text: res.ok ? res.detail : res.error };
    this.lastTests.set(id, lastTest);
    return res.ok ? { ok: true, detail: res.detail, lastTest } : { ok: false, error: res.error, lastTest };
  }

  /// What the form would ask for, read from the app itself. Nothing is saved.
  async discover(caller: OrgCaller, address: string, username?: string): Promise<{ ok: true; found: Discovered } | { ok: false; error: string }> {
    const no = this.denied(caller);
    if (no) return no;
    if (!this.deps.discover) return { ok: false, error: 'This server can’t open a browser to look.' };
    if (!address.trim()) return { ok: false, error: 'Give the app’s address.' };
    return this.deps.discover(address.trim(), username);
  }

  /// The tool, with only the credentials of `systems` in its env.
  private install(systems: TestSystem[], env: Record<string, string>): { ok: true } | { ok: false; error: string } {
    const keep = new Set(systems.flatMap((s) => systemEnvNames(s)));
    const sealed = Object.fromEntries(Object.entries(env).filter(([k]) => keep.has(k)));
    const res = this.deps.tools.install({
      name: TEST_SYSTEMS_TOOL,
      kind: 'command',
      command: process.execPath,
      args: [this.deps.serverScript(), '--systems', this.deps.file()],
      env: { ...sealed, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    });
    return res.ok ? { ok: true } : res;
  }
}

/// Where the compiled server sits beside this module.
export function testSystemsServerScript(): string {
  return path.join(__dirname, 'testSystemsServer.js');
}
