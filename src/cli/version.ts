import fs from 'node:fs';
import path from 'node:path';

/// This build's version, from package.json.
export function version(): string {
  try {
    // Two levels up from dist/cli/, and from src/cli/ when run through tsx.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return String(pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}
