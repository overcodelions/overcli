// Live rendering for .tsx/.jsx previews.
//
// The React preview used to be a static analysis card — export names and
// tag counts — which is useless when what you generated is a *design* and
// what you want is to look at it. So we bundle the component here with
// esbuild (already on disk as Vite's bundler) and hand the renderer a
// self-contained script it can drop into a sandboxed iframe.
//
// Everything is bundled in: React, the component's imports, any CSS or
// images it pulls in. That matters because the preview iframe runs on an
// opaque origin and cannot fetch anything from disk itself — see
// ./htmlPreviewAssets.ts for the same constraint on the HTML side.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { ReactPreviewBundleResult, ReactPreviewTailwind } from '../shared/types';

const execFileAsync = promisify(execFile);

/// The main process is CommonJS, so `require` is normally right there. It
/// isn't under the test runner's ESM transform, hence the fallback.
const nodeRequire =
  typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'noop.js'));

/// The Tailwind CLI is a cold Node process scanning a file — a second or
/// two normally, but a huge project config can be slower.
const TAILWIND_TIMEOUT_MS = 30_000;
const PREVIEW_ROOT_ID = 'overcli-preview-root';

const ASSET_LOADERS: Record<string, 'dataurl' | 'text'> = {
  '.avif': 'dataurl',
  '.gif': 'dataurl',
  '.ico': 'dataurl',
  '.jpeg': 'dataurl',
  '.jpg': 'dataurl',
  '.otf': 'dataurl',
  '.png': 'dataurl',
  '.svg': 'dataurl',
  '.ttf': 'dataurl',
  '.webp': 'dataurl',
  '.woff': 'dataurl',
  '.woff2': 'dataurl',
  '.txt': 'text',
};

export interface ReactPreviewDeps {
  isReadable(target: string): boolean;
  /// Injected so tests can exercise the missing-esbuild path without
  /// uninstalling it.
  loadEsbuild?: () => any;
  /// Set false to skip the Tailwind pass (tests, and the caller when the
  /// source has no class names to compile).
  tailwind?: boolean;
}

export async function buildReactPreviewBundle(
  args: { path: string; rootPath?: string; contents?: string },
  deps: ReactPreviewDeps,
): Promise<ReactPreviewBundleResult> {
  const filePath = args?.path ?? '';
  if (!filePath || !path.isAbsolute(filePath) || !deps.isReadable(filePath)) {
    return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
  }
  if (!/\.(tsx|jsx)$/i.test(filePath)) {
    return { ok: false, error: 'Live preview only renders .tsx and .jsx files.' };
  }

  const esbuild = loadEsbuildOrNull(deps.loadEsbuild);
  if (!esbuild) {
    return {
      ok: false,
      error: 'esbuild is not available in this build, so components cannot be compiled.',
      hint: 'esbuild-missing',
    };
  }

  const fileDir = path.dirname(filePath);
  const react = resolveReact(fileDir);
  if (!react) {
    return {
      ok: false,
      error:
        'React could not be resolved for this file. Install react and react-dom in the project so the component can be compiled.',
      hint: 'react-missing',
    };
  }

  const source = args.contents ?? safeRead(filePath);
  let built;
  try {
    built = await esbuild.build({
      stdin: {
        contents: entryModule(filePath),
        resolveDir: fileDir,
        sourcefile: 'overcli-preview-entry.tsx',
        loader: 'tsx',
      },
      absWorkingDir: fileDir,
      bundle: true,
      write: false,
      // Nothing is written (`write: false`), but naming the output is what
      // makes esbuild emit the JS and the imported CSS as two files
      // instead of one unnamed `<stdout>` blob.
      outfile: path.join(fileDir, 'overcli-preview.js'),
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      jsx: 'automatic',
      sourcemap: false,
      logLevel: 'silent',
      logLimit: 12,
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: ASSET_LOADERS,
      nodePaths: react.nodePaths,
      plugins: [liveBufferPlugin(filePath, args.contents)],
    });
  } catch (err: any) {
    const details = formatMessages([...(err?.errors ?? []), ...(err?.warnings ?? [])]);
    return {
      ok: false,
      error: 'The component did not compile.',
      details: details.length ? details : [err?.message ?? String(err)],
      hint: 'build-failed',
    };
  }

  const outputs: Array<{ path: string; text: string }> = built.outputFiles ?? [];
  const js = outputs.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = outputs
    .filter((f) => f.path.endsWith('.css'))
    .map((f) => f.text)
    .join('\n');
  if (!js) {
    return { ok: false, error: 'esbuild produced no output for this component.', hint: 'build-failed' };
  }

  const tailwind =
    deps.tailwind === false
      ? { status: 'skipped' as const }
      : await compileTailwind(filePath, source, args.rootPath);

  return {
    ok: true,
    js,
    css,
    tailwindCss: tailwind.css,
    tailwind: { status: tailwind.status, message: tailwind.message, version: tailwind.version },
    rootElementId: PREVIEW_ROOT_ID,
    reactSource: react.source,
    warnings: formatMessages(built.warnings ?? []),
  };
}

/// The entry esbuild actually compiles: it imports the component module
/// and mounts whatever component it can find, with an error boundary so a
/// throwing render shows the stack instead of a blank frame.
function entryModule(filePath: string): string {
  return `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as target from ${JSON.stringify(filePath)};

const container = document.getElementById(${JSON.stringify(PREVIEW_ROOT_ID)});

function showFailure(title, detail) {
  const box = document.createElement('pre');
  box.className = 'overcli-preview-error';
  box.textContent = detail ? title + '\\n\\n' + detail : title;
  container.appendChild(box);
}

// Async throws and effects that reject escape the error boundary, so they
// need their own net or the frame just goes quiet.
window.addEventListener('error', (event) => showFailure('Runtime error', String(event.message)));
window.addEventListener('unhandledrejection', (event) =>
  showFailure('Unhandled promise rejection', String(event.reason && event.reason.stack || event.reason)),
);

class PreviewErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const error = this.state.error;
      return (
        <pre className="overcli-preview-error">
          {String((error && error.stack) || error)}
          {'\\n\\nIf this component needs props, the preview cannot guess them — render it from a wrapper that supplies them.'}
        </pre>
      );
    }
    return this.props.children;
  }
}

/// Default export wins; otherwise the first capitalized function export,
/// which is what a generated design file almost always exposes.
function pickComponent(mod) {
  if (typeof mod.default === 'function') return { name: 'default', value: mod.default };
  for (const name of Object.keys(mod)) {
    if (name === 'default') continue;
    if (typeof mod[name] === 'function' && /^[A-Z]/.test(name)) return { name, value: mod[name] };
  }
  return null;
}

const picked = pickComponent(target);
if (!picked) {
  showFailure(
    'No component export found.',
    'Export a React component (default, or a capitalized named export) to preview it.',
  );
} else {
  const Component = picked.value;
  document.documentElement.setAttribute('data-overcli-component', picked.name);
  createRoot(container).render(
    <PreviewErrorBoundary>
      <Component />
    </PreviewErrorBoundary>,
  );
}
`;
}

/// Feeds esbuild the editor's unsaved buffer for the previewed file, so
/// the preview tracks what you are looking at rather than what was last
/// written to disk.
function liveBufferPlugin(filePath: string, contents: string | undefined) {
  return {
    name: 'overcli-live-buffer',
    setup(build: any) {
      if (contents == null) return;
      build.onLoad({ filter: /\.(tsx|jsx)$/ }, (loadArgs: { path: string }) => {
        if (path.resolve(loadArgs.path) !== path.resolve(filePath)) return null;
        return { contents, loader: filePath.toLowerCase().endsWith('.jsx') ? 'jsx' : 'tsx' };
      });
    },
  };
}

/// Prefer the project's own React so the preview matches what the app
/// renders; fall back to Overcli's copy so a scratch file outside any
/// installed project still previews.
function resolveReact(fileDir: string): { source: 'project' | 'overcli'; nodePaths: string[] } | null {
  let dir = fileDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(candidate, 'react', 'package.json'))) {
      return { source: 'project', nodePaths: [candidate] };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const own = outsideAsar(path.dirname(path.dirname(nodeRequire.resolve('react/package.json'))));
    if (fs.existsSync(path.join(own, 'react-dom', 'package.json'))) {
      return { source: 'overcli', nodePaths: [own] };
    }
  } catch {
    // No React anywhere we can point esbuild at. Falls through to null,
    // and the caller explains how to install one.
  }
  return null;
}

function loadEsbuildOrNull(loader?: () => any): any {
  try {
    if (loader) return loader();
    pointEsbuildAtItsUnpackedBinary();
    return nodeRequire('esbuild');
  } catch {
    return null;
  }
}

/// esbuild's JS shim spawns a native binary next to itself. In a packaged
/// build that path lands inside app.asar, which nothing outside Electron
/// can execute — electron-builder unpacks it, and this env var is how
/// esbuild is told where the real file went.
function pointEsbuildAtItsUnpackedBinary(): void {
  if (process.env.ESBUILD_BINARY_PATH) return;
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  try {
    const packageRoot = path.dirname(nodeRequire.resolve(`${platformPackage}/package.json`));
    const binary = outsideAsar(path.join(packageRoot, binaryName));
    if (fs.existsSync(binary)) process.env.ESBUILD_BINARY_PATH = binary;
  } catch {
    // Not installed per-platform (or resolution is blocked) — let esbuild
    // find its own binary the usual way.
  }
}

/// Rewrites an app.asar path to its app.asar.unpacked twin. A no-op in
/// development and for anything already outside the archive.
function outsideAsar(target: string): string {
  const packed = `app.asar${path.sep}`;
  return target.includes(packed) ? target.replace(packed, `app.asar.unpacked${path.sep}`) : target;
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/// esbuild reports errors and warnings as structured messages; flatten
/// them to the "file:line: text" lines a person can act on.
function formatMessages(messages: any[]): string[] {
  return messages.map((m: any) => {
    const where = m?.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ` : '';
    return `${where}${m?.text ?? ''}`.trim();
  });
}

/// Tailwind classes are compiled by the project's own Tailwind, not a
/// bundled copy — version, plugins and theme all live in the project, and
/// a preview styled by a different Tailwind would be a lie.
async function compileTailwind(
  filePath: string,
  source: string,
  rootPath: string | undefined,
): Promise<ReactPreviewTailwind & { css?: string }> {
  if (!/\bclassName\s*=/.test(source)) return { status: 'not-used' };
  const projectRoot = findProjectRoot(filePath, rootPath);
  if (!projectRoot) return { status: 'unavailable', message: 'No project root found for this file.' };

  const binary = tailwindBinary(projectRoot);
  const version = tailwindMajorVersion(projectRoot);
  if (!binary || version == null) {
    return {
      status: 'unavailable',
      message: 'Tailwind classes are not compiled — install tailwindcss in this project.',
    };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-tw-preview-'));
  const inputPath = path.join(workDir, 'input.css');
  const outputPath = path.join(workDir, 'output.css');
  try {
    // v4 takes its content sources from the stylesheet itself; v3 takes
    // them from a CLI flag, which also overrides a project config whose
    // globs would not cover a scratch file.
    const cliArgs =
      version >= 4
        ? ['--input', inputPath, '--output', outputPath]
        : ['--input', inputPath, '--output', outputPath, '--content', filePath];
    fs.writeFileSync(
      inputPath,
      version >= 4
        ? `@import "tailwindcss";\n@source ${JSON.stringify(filePath)};\n`
        : '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
      'utf-8',
    );
    await execFileAsync(binary, cliArgs, { cwd: projectRoot, timeout: TAILWIND_TIMEOUT_MS });
    return { status: 'compiled', version, css: fs.readFileSync(outputPath, 'utf-8') };
  } catch (err: any) {
    return {
      status: 'failed',
      version,
      message: (err?.stderr || err?.message || 'Tailwind compilation failed.').toString().slice(0, 600),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function findProjectRoot(filePath: string, rootPath: string | undefined): string | null {
  let dir = path.dirname(filePath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return rootPath && fs.existsSync(rootPath) ? rootPath : null;
}

function tailwindBinary(projectRoot: string): string | null {
  const names = process.platform === 'win32' ? ['tailwindcss.cmd', 'tailwindcss'] : ['tailwindcss'];
  for (const name of names) {
    const candidate = path.join(projectRoot, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function tailwindMajorVersion(projectRoot: string): number | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'node_modules', 'tailwindcss', 'package.json'), 'utf-8'),
    );
    const major = Number.parseInt(String(pkg.version ?? '').split('.')[0], 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}
