// node-pty ships its macOS `spawn-helper` inside the npm tarball without the
// execute bit, so every PTY spawn fails with "posix_spawnp failed". Set it
// here, after install, so both `npm run dev` and the packaged app (which
// copies these files with their mode intact) can open a terminal.
//
// Runs as this package's postinstall, including when it is installed as a
// dependency, so it resolves node-pty wherever npm put it and never fails
// the install over a terminal.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let root;
try {
  root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}

const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
try {
  for (const dir of fs.readdirSync(path.join(root, 'prebuilds'))) {
    candidates.push(path.join(root, 'prebuilds', dir, 'spawn-helper'));
  }
} catch {
  // No prebuilds folder: a source build, covered by build/Release above.
}

for (const file of candidates) {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Absent on this platform (Windows has no spawn-helper).
  }
}
