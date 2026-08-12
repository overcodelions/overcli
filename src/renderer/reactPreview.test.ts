import { describe, expect, it } from 'vitest';
import { buildReactPreviewDocument } from './reactPreview';

const bundle = {
  ok: true as const,
  js: 'console.log("mounted")',
  css: '.card { color: red }',
  tailwind: { status: 'not-used' as const },
  rootElementId: 'overcli-preview-root',
  reactSource: 'project' as const,
  warnings: [],
};

describe('buildReactPreviewDocument', () => {
  it('mounts into the element the bundle expects and runs the bundle', () => {
    const doc = buildReactPreviewDocument(bundle, 'light');
    expect(doc).toContain('<div id="overcli-preview-root"></div>');
    expect(doc).toContain('<script>console.log("mounted")</script>');
    expect(doc.indexOf('overcli-preview-root')).toBeLessThan(doc.indexOf('<script>'));
  });

  it('includes bundled and Tailwind css, Tailwind first so components can override', () => {
    const doc = buildReactPreviewDocument({ ...bundle, tailwindCss: '.p-4{padding:1rem}' }, 'light');
    expect(doc.indexOf('.p-4{padding:1rem}')).toBeLessThan(doc.indexOf('.card { color: red }'));
  });

  it('omits empty style blocks', () => {
    const doc = buildReactPreviewDocument({ ...bundle, css: '' }, 'light');
    expect(doc).not.toContain('<style></style>');
  });

  it('sets the dark class and color-scheme for a dark background', () => {
    const doc = buildReactPreviewDocument(bundle, 'dark');
    expect(doc).toContain('<html lang="en" class="dark">');
    expect(doc).toContain('color-scheme: dark');
    expect(buildReactPreviewDocument(bundle, 'light')).toContain('<html lang="en">');
  });

  it('neutralizes a closing script tag inside the bundle', () => {
    const doc = buildReactPreviewDocument(
      { ...bundle, js: 'var s = "</script><img onerror=alert(1)>"' },
      'light',
    );
    expect(doc).not.toContain('</script><img');
    expect(doc).toContain('<\\/script>');
  });

  it('neutralizes a closing style tag inside bundled css', () => {
    const doc = buildReactPreviewDocument(
      { ...bundle, css: '/* </style><script>alert(1)</script> */' },
      'light',
    );
    expect(doc).not.toContain('</style><script>');
  });
});
