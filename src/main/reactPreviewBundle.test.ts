import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReactPreviewBundle } from './reactPreviewBundle';

let root: string;
const deps = {
  isReadable: (target: string) => path.resolve(target).startsWith(root),
  // The Tailwind pass shells out to a project binary; the tests that care
  // about it opt in explicitly.
  tailwind: false,
};

function write(relative: string, content: string): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-react-preview-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildReactPreviewBundle', () => {
  it('compiles a component into a mountable bundle', async () => {
    const file = write(
      'Card.tsx',
      'export default function Card() {\n  return <div className="card">Hello</div>;\n}\n',
    );
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rootElementId).toBe('overcli-preview-root');
    // React is bundled in, not left as a bare import the iframe cannot resolve.
    expect(res.js).not.toMatch(/^\s*import\s/m);
    expect(res.js).toContain('overcli-preview-root');
    expect(res.js).toContain('Hello');
    expect(res.reactSource).toBe('overcli');
    expect(res.warnings).toEqual([]);
  }, 30_000);

  it('renders the unsaved buffer rather than what is on disk', async () => {
    const file = write('Card.tsx', 'export default function Card() { return <div>saved</div>; }');
    const res = await buildReactPreviewBundle(
      { path: file, contents: 'export default function Card() { return <div>buffer</div>; }' },
      deps,
    );
    expect(res.ok && res.js).toContain('buffer');
    expect(res.ok && res.js).not.toContain('saved');
  }, 30_000);

  it('bundles a stylesheet the component imports', async () => {
    write('card.css', '.card { color: rebeccapurple; }');
    const file = write(
      'Card.tsx',
      "import './card.css';\nexport default function Card() { return <div className='card' />; }\n",
    );
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res.ok && res.css).toContain('rebeccapurple');
  }, 30_000);

  it('compiles a component exported by name', async () => {
    const file = write('Hero.tsx', 'export function Hero() { return <h1>Hero</h1>; }');
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res.ok).toBe(true);
  }, 30_000);

  it('reports a syntax error with its location instead of failing silently', async () => {
    const file = write('Broken.tsx', 'export default function Broken() { return <div>; }');
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.hint).toBe('build-failed');
    expect(res.details?.length).toBeGreaterThan(0);
    expect(res.details?.join('\n')).toContain('Broken.tsx');
  }, 30_000);

  it('reports an unresolvable import', async () => {
    const file = write(
      'Card.tsx',
      "import { Thing } from './nope';\nexport default function Card() { return <Thing />; }",
    );
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.details?.join('\n')).toMatch(/nope/);
  }, 30_000);

  it('refuses files outside the readable roots', async () => {
    const res = await buildReactPreviewBundle({ path: '/etc/hosts.tsx' }, deps);
    expect(res).toEqual({
      ok: false,
      error: 'File is outside any registered project, workspace, or worktree.',
    });
  });

  it('refuses non-component files', async () => {
    const file = write('notes.md', '# hi');
    const res = await buildReactPreviewBundle({ path: file }, deps);
    expect(res).toEqual({ ok: false, error: 'Live preview only renders .tsx and .jsx files.' });
  });

  it('degrades with a clear hint when esbuild is unavailable', async () => {
    const file = write('Card.tsx', 'export default function Card() { return <div />; }');
    const res = await buildReactPreviewBundle(
      { path: file },
      {
        ...deps,
        loadEsbuild: () => {
          throw new Error('Cannot find module esbuild');
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.hint).toBe('esbuild-missing');
  });

  it('skips the Tailwind pass for a component with no class names', async () => {
    const file = write('Plain.tsx', 'export default function Plain() { return <div>plain</div>; }');
    const res = await buildReactPreviewBundle({ path: file }, { isReadable: deps.isReadable });
    expect(res.ok && res.tailwind.status).toBe('not-used');
  }, 30_000);

  it('says so when a project has class names but no Tailwind installed', async () => {
    write('package.json', '{"name":"design-scratch"}');
    const file = write(
      'Card.tsx',
      'export default function Card() { return <div className="p-4 text-lg" />; }',
    );
    const res = await buildReactPreviewBundle({ path: file }, { isReadable: deps.isReadable });
    expect(res.ok && res.tailwind.status).toBe('unavailable');
    expect(res.ok && res.tailwind.message).toMatch(/install tailwindcss/i);
  }, 30_000);
});
