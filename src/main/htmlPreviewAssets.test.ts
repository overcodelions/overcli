import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHtmlPreviewAssets } from './htmlPreviewAssets';

let root: string;
const readable = (target: string) => path.resolve(target).startsWith(root);

function write(relative: string, content: string | Buffer): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-html-assets-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readHtmlPreviewAssets', () => {
  it('reads a sibling stylesheet as text', () => {
    const html = write('page.html', '');
    write('styles.css', 'body{color:red}');
    const res = readHtmlPreviewAssets({ path: html, refs: ['styles.css'] }, readable);
    expect(res).toEqual({
      ok: true,
      assets: { 'styles.css': { ok: true, kind: 'css', text: 'body{color:red}' } },
    });
  });

  it('ignores query strings and fragments when resolving', () => {
    const html = write('page.html', '');
    write('styles.css', 'body{color:red}');
    const res = readHtmlPreviewAssets({ path: html, refs: ['./styles.css?v=3'] }, readable);
    expect(res.ok && res.assets['./styles.css?v=3']).toEqual({
      ok: true,
      kind: 'css',
      text: 'body{color:red}',
    });
  });

  it('resolves a root-relative ref against the project root', () => {
    const html = write('pages/page.html', '');
    write('assets/app.css', 'h1{font-size:2rem}');
    const res = readHtmlPreviewAssets(
      { path: html, rootPath: root, refs: ['/assets/app.css'] },
      readable,
    );
    expect(res.ok && res.assets['/assets/app.css']).toEqual({
      ok: true,
      kind: 'css',
      text: 'h1{font-size:2rem}',
    });
  });

  it('folds @import and url() refs into the stylesheet it returns', () => {
    const html = write('page.html', '');
    write('css/base.css', 'a{color:blue}');
    write('css/app.css', "@import 'base.css';\nbody{background:url(../img/bg.png)}");
    write('img/bg.png', Buffer.from([1, 2, 3]));
    const res = readHtmlPreviewAssets({ path: html, refs: ['css/app.css'] }, readable);
    const asset = res.ok ? res.assets['css/app.css'] : null;
    expect(asset?.ok && asset.kind === 'css' && asset.text).toBe(
      `a{color:blue}\nbody{background:url("data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}")}`,
    );
  });

  it('wraps a media-qualified @import in @media', () => {
    const html = write('page.html', '');
    write('print.css', 'body{color:black}');
    write('app.css', "@import url('print.css') print;");
    const res = readHtmlPreviewAssets({ path: html, refs: ['app.css'] }, readable);
    const asset = res.ok ? res.assets['app.css'] : null;
    expect(asset?.ok && asset.kind === 'css' && asset.text).toBe(
      '@media print {\nbody{color:black}\n}',
    );
  });

  it('survives a circular @import', () => {
    const html = write('page.html', '');
    write('a.css', "@import 'b.css';\n.a{}");
    write('b.css', "@import 'a.css';\n.b{}");
    const res = readHtmlPreviewAssets({ path: html, refs: ['a.css'] }, readable);
    const asset = res.ok ? res.assets['a.css'] : null;
    // The back-reference to a.css resolves to nothing rather than recursing.
    expect(asset?.ok && asset.kind === 'css' && asset.text).toBe('\n.b{}\n.a{}');
  });

  it('leaves remote url() refs alone', () => {
    const html = write('page.html', '');
    write('app.css', 'body{background:url(https://cdn.example.com/bg.png)}');
    const res = readHtmlPreviewAssets({ path: html, refs: ['app.css'] }, readable);
    const asset = res.ok ? res.assets['app.css'] : null;
    expect(asset?.ok && asset.kind === 'css' && asset.text).toBe(
      'body{background:url(https://cdn.example.com/bg.png)}',
    );
  });

  it('returns images as data urls', () => {
    const html = write('page.html', '');
    write('logo.png', Buffer.from([0xde, 0xad]));
    const res = readHtmlPreviewAssets({ path: html, refs: ['logo.png'] }, readable);
    expect(res.ok && res.assets['logo.png']).toEqual({
      ok: true,
      kind: 'data',
      dataUrl: `data:image/png;base64,${Buffer.from([0xde, 0xad]).toString('base64')}`,
    });
  });

  it('refuses refs that escape the readable roots', () => {
    const html = write('page.html', '');
    const res = readHtmlPreviewAssets({ path: html, refs: ['../../etc/passwd'] }, readable);
    const asset = res.ok ? res.assets['../../etc/passwd'] : null;
    expect(asset?.ok).toBe(false);
  });

  it('refuses a document outside the readable roots', () => {
    expect(readHtmlPreviewAssets({ path: '/etc/hosts', refs: ['a.css'] }, readable)).toEqual({
      ok: false,
      error: 'File is outside any registered project, workspace, or worktree.',
    });
  });

  it('reports a missing asset without failing the batch', () => {
    const html = write('page.html', '');
    write('styles.css', 'body{}');
    const res = readHtmlPreviewAssets({ path: html, refs: ['styles.css', 'gone.css'] }, readable);
    expect(res.ok && res.assets['styles.css'].ok).toBe(true);
    expect(res.ok && res.assets['gone.css'].ok).toBe(false);
  });
});
