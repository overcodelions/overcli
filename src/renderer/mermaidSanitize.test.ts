// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { extractMermaidBlocks, renderMermaidDiagrams, sanitizeMermaidSvg } from './mermaid';

/// These need a DOM, so they run under jsdom while the rest of the suite stays
/// on `node`. The reason they exist: a sanitize config that strips geometry
/// still returns a plausible-looking SVG of the right size, so the preview
/// renders a correctly-spaced blank box and every other test stays green.
/// jsdom has no layout engine, so text measurement is stubbed — enough for
/// mermaid to emit a real SVG, which is all these assert on.
beforeAll(() => {
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  proto.getComputedTextLength = () => 100;
});

describe('sanitizeMermaidSvg', () => {
  it('keeps the attributes a diagram needs to be visible', () => {
    const svg = [
      '<svg id="m0" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 116 36">',
      '<g transform="translate(4,4)">',
      '<path d="M1,1L2,2" marker-end="url(#m0_pointEnd)" stroke="#fff" fill="none"/>',
      '<text x="5" y="6" text-anchor="middle">Hi</text>',
      '</g></svg>',
    ].join('');
    const clean = sanitizeMermaidSvg(svg);
    for (const attr of [
      'viewBox="-8 -8 116 36"',
      'transform="translate(4,4)"',
      'width="100%"',
      'marker-end',
      'text-anchor',
      'd="M1,1L2,2"',
    ]) {
      expect(clean, `dropped ${attr}`).toContain(attr);
    }
  });

  it('still strips script, event handlers, and foreignObject', () => {
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<script>alert(1)</script>',
      '<foreignObject><div onclick="alert(2)">html</div></foreignObject>',
      '<rect width="10" height="10" onload="alert(3)"/>',
      '<a href="javascript:alert(4)"><text>x</text></a>',
      '</svg>',
    ].join('');
    const clean = sanitizeMermaidSvg(hostile);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('foreignObject');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('viewBox="0 0 10 10"');
  });
});

describe('renderMermaidDiagrams', () => {
  it('produces a real, still-geometric svg for a flowchart', async () => {
    const blocks = extractMermaidBlocks('```mermaid\ngraph TD\n  A[One] --> B[Two]\n```');
    expect(blocks).toHaveLength(1);

    const diagrams = await renderMermaidDiagrams(blocks, { dark: true });
    const result = diagrams[blocks[0].key];
    expect(result?.error).toBeUndefined();

    const svg = result?.svg ?? '';
    expect(svg).toContain('viewBox');
    expect(svg).toContain('transform=');
    expect(svg).toContain('<style');
    expect(svg).toContain('<path');
    // A diagram whose geometry was sanitized away still looks like an svg;
    // length is the cheap guard against it collapsing to a husk.
    expect(svg.length).toBeGreaterThan(2000);
  });

  it('reports a parse failure instead of throwing', async () => {
    const blocks = extractMermaidBlocks('```mermaid\ngraph TD\n  A --> ((((\n```');
    const diagrams = await renderMermaidDiagrams(blocks, { dark: false });
    const result = diagrams[blocks[0].key];
    expect(result?.svg).toBeNull();
    expect(result?.error).toBeTruthy();
  });

  it('gives concurrent passes distinct dom ids', async () => {
    const blocks = extractMermaidBlocks('```mermaid\ngraph LR\n  X --> Y\n```');
    const [a, b] = await Promise.all([
      renderMermaidDiagrams(blocks, { dark: true }),
      renderMermaidDiagrams(blocks, { dark: true }),
    ]);
    const first = a[blocks[0].key];
    const second = b[blocks[0].key];
    // Shared ids made each pass delete the other's scratch node mid-render,
    // and both died on `element.firstChild`.
    expect(first?.error).toBeUndefined();
    expect(second?.error).toBeUndefined();
    expect(first?.svg).toBeTruthy();
    expect(second?.svg).toBeTruthy();
  });
});
