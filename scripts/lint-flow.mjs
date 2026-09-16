#!/usr/bin/env node
// Run the flow cost lint against flow YAML files on disk.
//
//   node scripts/lint-flow.mjs <file.yaml> [more.yaml ...]
//
// The editor shows these warnings live while you edit (FlowEditor.tsx) and
// preflight repeats them at run launch, but neither helps you look at a flow
// you have not opened — a registry flow, a worker-drafted one, or a file
// someone sent you. Same rules, same source (shared/flows/lint.ts): this is
// only a different way in.
//
// Exits 1 if a file fails to parse or fails validation, 0 otherwise. Cost
// warnings never affect the exit code — a warned flow is valid and runnable.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (files.length === 0) {
  console.error('usage: node scripts/lint-flow.mjs <flow.yaml> [...]');
  process.exit(2);
}

// The rules live in TypeScript next to the code that uses them, so there is
// one copy rather than a drifting script-local reimplementation. Bundle them
// to a temp file and import that.
//
// `yaml` stays EXTERNAL: it is CommonJS and calls require('process'), which
// esbuild cannot rewrite into an ESM bundle. Leaving it external means the
// output has a bare `import 'yaml'` in it, so the temp file has to sit
// somewhere node can resolve node_modules from — hence inside the repo
// rather than the system temp dir.
const bundled = await build({
  stdin: {
    contents: `
      export { parseFlowYaml } from './src/shared/flows/yaml';
      export { lintFlow } from './src/shared/flows/lint';
      export { validateFlow } from './src/shared/flows/validation';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  external: ['yaml'],
  logLevel: 'silent',
});
const tmp = path.join(process.cwd(), 'node_modules', `.overcli-lint-flow-${process.pid}.mjs`);
fs.writeFileSync(tmp, bundled.outputFiles[0].text);
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  fs.rmSync(tmp, { force: true });
}
const { parseFlowYaml, lintFlow, validateFlow } = mod;

let bad = false;
for (const file of files) {
  const abs = path.resolve(file);
  console.log(`\n${abs}`);
  let body;
  try {
    body = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    console.log(`  ✗ cannot read: ${err.message}`);
    bad = true;
    continue;
  }
  const flow = parseFlowYaml({
    yaml: body,
    id: path.basename(abs).replace(/\.ya?ml$/i, ''),
    source: 'user',
    filePath: abs,
  });
  if (!flow) {
    console.log('  ✗ not a parseable flow document');
    bad = true;
    continue;
  }

  const validation = validateFlow(flow);
  for (const e of validation.errors) {
    console.log(`  ✗ ${e.path}: ${e.message}`);
  }
  if (!validation.ok) bad = true;

  const warnings = lintFlow(flow);
  for (const w of warnings) {
    console.log(`  ⚠ ${w.path}: ${w.message}${w.hint ? `\n      → ${w.hint}` : ''}`);
  }

  if (validation.ok && warnings.length === 0) console.log('  ✓ no problems');
  else console.log(`  ${validation.errors.length} error(s), ${warnings.length} warning(s)`);
}

process.exit(bad ? 1 : 0);
