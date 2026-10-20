// `npm run dev:serve`'s server half: runs `overcli serve` and restarts it
// when the compiled code changes — but only once dist/ has been quiet for a
// few seconds. `node --watch` restarted on every file the compiler wrote, so
// one save meant several restarts, and anyone else editing the tree kept
// cutting a worker off mid-run. Runs a restart does interrupt are carried on
// by the server itself when it comes back (serve.ts).
//
// Arguments after the script name go to `overcli serve`.

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const args = [path.join(dist, 'cli/index.js'), 'serve', ...process.argv.slice(2)];
const QUIET_MS = 4000;

let child = null;
let stopping = false;
let timer = null;

function start() {
  child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    if (signal !== 'SIGTERM') console.log(`[dev:serve] the server stopped (${signal ?? `exit ${code}`}); it restarts on the next change.`);
  });
}

function restart() {
  if (!child) return start();
  console.log('[dev:serve] code changed — restarting the server');
  child.once('exit', () => start());
  child.kill('SIGTERM');
}

watch(dist, { recursive: true }, (_event, file) => {
  if (!file || file.endsWith('.map') || file.includes('.test.')) return;
  clearTimeout(timer);
  timer = setTimeout(restart, QUIET_MS);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
    if (child) child.kill('SIGTERM');
    else process.exit(0);
  });
}

start();
