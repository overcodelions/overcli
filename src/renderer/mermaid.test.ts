import { describe, expect, it } from 'vitest';
import {
  applyMermaidDiagrams,
  extractMermaidBlocks,
  mermaidKey,
  mermaidPlaceholderHtml,
} from './mermaid';

describe('extractMermaidBlocks', () => {
  it('finds mermaid fences and ignores other languages', () => {
    const md = [
      '# Title',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '```',
      'plain',
      '```',
    ].join('\n');
    expect(extractMermaidBlocks(md)).toEqual([
      { key: mermaidKey('graph TD; A-->B;'), code: 'graph TD; A-->B;' },
    ]);
  });

  it('finds fences nested in lists and blockquotes', () => {
    const md = [
      '- step one',
      '',
      '  ```mermaid',
      '  graph LR; A-->B;',
      '  ```',
      '',
      '> quoted',
      '>',
      '> ```mermaid',
      '> sequenceDiagram',
      '> ```',
    ].join('\n');
    expect(extractMermaidBlocks(md).map((b) => b.code)).toEqual([
      'graph LR; A-->B;',
      'sequenceDiagram',
    ]);
  });

  it('ignores a mermaid fence nested inside a larger fence', () => {
    const md = ['````markdown', '```mermaid', 'graph TD; A-->B;', '```', '````'].join('\n');
    expect(extractMermaidBlocks(md)).toEqual([]);
  });

  it('honours an info string with extra words, and skips empty fences', () => {
    expect(extractMermaidBlocks('```mermaid  \ngraph TD; A-->B;\n```')).toHaveLength(1);
    expect(extractMermaidBlocks('```mermaidjs\nnot ours\n```')).toEqual([]);
    expect(extractMermaidBlocks('```mermaid\n\n```')).toEqual([]);
  });

  it('collapses duplicate diagrams onto one render', () => {
    const fence = '```mermaid\ngraph TD; A-->B;\n```';
    expect(extractMermaidBlocks(`${fence}\n\n${fence}`)).toHaveLength(1);
  });
});

describe('applyMermaidDiagrams', () => {
  const code = 'graph TD; A-->B;';
  const blocks = [{ key: mermaidKey(code), code }];
  const html = `<p>before</p>${mermaidPlaceholderHtml(code)}<p>after</p>`;

  it('swaps in rendered svg', () => {
    const out = applyMermaidDiagrams(html, blocks, {
      [blocks[0].key]: { svg: '<svg><g/></svg>' },
    });
    expect(out).toBe('<p>before</p><figure class="mermaid-diagram"><svg><g/></svg></figure><p>after</p>');
    expect(out).not.toContain('data-mermaid-key');
  });

  it('falls back to the source as a code block while the render is pending', () => {
    const out = applyMermaidDiagrams(html, blocks, {});
    expect(out).toContain('is-pending');
    expect(out).toContain('graph TD; A--&gt;B;');
  });

  it('shows the reason when a diagram fails', () => {
    const out = applyMermaidDiagrams(html, blocks, {
      [blocks[0].key]: { svg: null, error: 'Parse error on line 1' },
    });
    expect(out).toContain('is-error');
    expect(out).toContain('Parse error on line 1');
    expect(out).toContain('graph TD; A--&gt;B;');
  });

  it('escapes diagram source and error text', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    const nastyBlocks = [{ key: mermaidKey(nasty), code: nasty }];
    const out = applyMermaidDiagrams(
      mermaidPlaceholderHtml(nasty),
      nastyBlocks,
      { [nastyBlocks[0].key]: { svg: null, error: '<script>x</script>' } },
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;img');
  });

  it('matches placeholders regardless of attribute order', () => {
    const reordered = `<div data-mermaid-key="${blocks[0].key}" class="mermaid-diagram"></div>`;
    const out = applyMermaidDiagrams(reordered, blocks, {
      [blocks[0].key]: { svg: '<svg/>' },
    });
    expect(out).toBe('<figure class="mermaid-diagram"><svg/></figure>');
  });

  it('leaves html without placeholders untouched', () => {
    expect(applyMermaidDiagrams('<p>hi</p>', [], {})).toBe('<p>hi</p>');
  });

  it('leaves an orphaned placeholder alone rather than emptying it', () => {
    const orphan = '<div class="mermaid-diagram" data-mermaid-key="nope"></div>';
    expect(applyMermaidDiagrams(orphan, blocks, {})).toBe(orphan);
  });
});

describe('mermaidKey', () => {
  it('is stable and distinguishes different sources', () => {
    expect(mermaidKey('graph TD; A-->B;')).toBe(mermaidKey('graph TD; A-->B;'));
    expect(mermaidKey('graph TD; A-->B;')).not.toBe(mermaidKey('graph TD; A-->C;'));
  });

  it('produces a key safe for an html attribute and a dom id', () => {
    expect(mermaidKey('graph TD; A-->B;')).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
