import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let diagnostics: typeof import('./diagnostics');

beforeEach(async () => {
  vi.spyOn(os, 'homedir').mockReturnValue('/tmp/overcli-home');
  vi.spyOn(fs, 'mkdirSync');
  vi.spyOn(fs, 'statSync').mockImplementation(() => {
    const err = new Error('ENOENT');
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  });
  vi.spyOn(fs, 'appendFileSync');
  vi.spyOn(fs, 'renameSync');
  vi.spyOn(fs, 'unlinkSync');
  vi.spyOn(fs, 'writeFileSync');
  vi.resetModules();
  diagnostics = await import('./diagnostics');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session log file', () => {
  it('appends uppercase level tokens to session.log', () => {
    diagnostics.log('warn', 'flows.parseRun', 'failed to parse persisted run run.json');

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join('/tmp/overcli-home', '.overcli'), {
      recursive: true,
      mode: 0o700,
    });
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      expect.stringMatching(/^\[[^\]]+\] WARN flows\.parseRun: failed to parse persisted run run\.json\n$/),
      'utf-8',
    );
  });

  it('clearSilentLog truncates session.log', () => {
    diagnostics.log('error', 'store.load', 'Failed to load overcli.json, starting fresh');
    diagnostics.clearSilentLog();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      '',
      'utf-8',
    );
  });

  it('rotates an oversized session.log before appending', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 2 * 1024 * 1024 } as fs.Stats);

    diagnostics.log('info', 'startup', 'session resumed');

    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join('/tmp/overcli-home', '.overcli', 'session.log.1'));
    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      path.join('/tmp/overcli-home', '.overcli', 'session.log.1'),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      '',
      'utf-8',
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      expect.stringMatching(/^\[[^\]]+\] INFO startup: session resumed\n$/),
      'utf-8',
    );
  });

  it('keeps statSync off the hot path between rotation checks', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 1 } as fs.Stats);

    diagnostics.log('info', 'startup', 'first');
    diagnostics.log('info', 'startup', 'second');

    // Checked on the first write, then skipped until the interval elapses.
    expect(fs.statSync).toHaveBeenCalledTimes(1);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
  });

  it('re-checks the size every ROTATION_CHECK_INTERVAL writes (not once per process)', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 1 } as fs.Stats);

    // First write checks; the next INTERVAL writes skip; the write after that
    // checks again. So INTERVAL + 2 writes triggers exactly two size checks.
    const writes = diagnostics.ROTATION_CHECK_INTERVAL + 2;
    for (let i = 0; i < writes; i++) diagnostics.log('info', 'startup', `#${i}`);

    expect(fs.statSync).toHaveBeenCalledTimes(2);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(writes);
  });

  it('rotates on a later periodic check once the file grows past the cap', () => {
    // Under cap on the first check, over cap by the time the next check runs.
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ size: 1 } as fs.Stats)
      .mockReturnValue({ size: 2 * 1024 * 1024 } as fs.Stats);

    const writes = diagnostics.ROTATION_CHECK_INTERVAL + 2;
    for (let i = 0; i < writes; i++) diagnostics.log('info', 'startup', `#${i}`);

    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      path.join('/tmp/overcli-home', '.overcli', 'session.log.1'),
    );
  });

  it('normalizes a malformed level so the file line is not silently dropped', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 1 } as fs.Stats);

    diagnostics.log(undefined as unknown as 'info', 'renderer', 'payload with no level');

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/overcli-home', '.overcli', 'session.log'),
      expect.stringMatching(/^\[[^\]]+\] INFO renderer: payload with no level\n$/),
      'utf-8',
    );
  });
});
