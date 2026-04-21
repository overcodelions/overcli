import { useEffect, useMemo, useState } from 'react';
import { detectFilePreviewKind } from '../filePreview';
import { renderMarkdownHtml } from './Markdown';

export function FilePreview({ path, content }: { path: string; content: string }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const kind = detectFilePreviewKind(path);
  const srcDoc = useMemo(() => {
    if (kind === 'html') return buildHtmlDocument(path, content);
    if (kind === 'markdown') return buildMarkdownDocument(path, content, dark);
    return '';
  }, [content, dark, kind, path]);

  if (!kind) {
    return <div className="p-4 text-xs text-ink-faint">Preview is not available for this file.</div>;
  }

  return (
    <iframe
      title={`${path} preview`}
      sandbox=""
      srcDoc={srcDoc}
      className="block w-full h-full border-0 bg-transparent"
    />
  );
}

function buildHtmlDocument(filePath: string, content: string): string {
  const baseTag = `<base href="${escapeAttr(toFileDirectoryHref(filePath))}">`;
  if (/<base[\s>]/i.test(content)) return content;
  if (/<head[\s>]/i.test(content)) return content.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${baseTag}`);
  if (/<html[\s>]/i.test(content)) {
    return content.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${baseTag}</head>`);
  }
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    baseTag,
    '<style>html,body{margin:0;padding:0;}</style>',
    '</head>',
    '<body>',
    content,
    '</body>',
    '</html>',
  ].join('');
}

function buildMarkdownDocument(filePath: string, content: string, dark: boolean): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<base href="${escapeAttr(toFileDirectoryHref(filePath))}">`,
    `<style>${markdownPreviewStyles(dark)}</style>`,
    '</head>',
    '<body>',
    `<article class="md">${renderMarkdownHtml(content, { escapeRawHtml: true, enableFilePathLinks: false })}</article>`,
    '</body>',
    '</html>',
  ].join('');
}

function markdownPreviewStyles(dark: boolean): string {
  const background = dark ? '#11151b' : '#f8fafc';
  const surface = dark ? '#171c23' : '#ffffff';
  const surfaceStrong = dark ? '#1e2630' : '#f1f5f9';
  const border = dark ? '#2a3340' : '#d8e0ea';
  const text = dark ? '#e6edf3' : '#17212b';
  const muted = dark ? '#9aa6b2' : '#52606d';
  const accent = dark ? '#8ab4ff' : '#2563eb';
  const code = dark ? '#0f141a' : '#f3f6fa';
  const inlineCode = dark ? '#202734' : '#eef2f7';
  const blockquote = dark ? '#b7c4d3' : '#5b6875';
  const hlKeyword = dark ? '#c586c0' : '#af00db';
  const hlString = dark ? '#ce9178' : '#a31515';
  const hlNumber = dark ? '#b5cea8' : '#098658';
  const hlComment = dark ? '#6a9955' : '#008000';
  const hlTitle = dark ? '#dcdcaa' : '#795e26';
  const hlType = dark ? '#4ec9b0' : '#267f99';
  const hlVariable = dark ? '#9cdcfe' : '#001080';
  const hlTag = dark ? '#569cd6' : '#800000';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${text}; }
    body {
      padding: 18px;
      font: 13px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .md { max-width: 980px; margin: 0 auto; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md h1 { font-size: 1.9em; margin: 0 0 0.6rem; }
    .md h2 { font-size: 1.45em; margin: 1.5rem 0 0.5rem; }
    .md h3 { font-size: 1.2em; margin: 1.15rem 0 0.45rem; }
    .md h4, .md h5, .md h6 { margin: 1rem 0 0.4rem; }
    .md p, .md ul, .md ol, .md pre, .md blockquote, .md table { margin: 0.6rem 0; }
    .md ul, .md ol { padding-left: 1.4rem; }
    .md li + li { margin-top: 0.2rem; }
    .md a { color: ${accent}; text-decoration: underline; text-underline-offset: 2px; }
    .md img, .md video { max-width: 100%; height: auto; }
    .md hr { border: 0; border-top: 1px solid ${border}; margin: 1rem 0; }
    .md blockquote {
      padding: 0.2rem 0 0.2rem 0.9rem;
      border-left: 3px solid ${border};
      color: ${blockquote};
    }
    .md table { border-collapse: collapse; max-width: 100%; display: block; overflow-x: auto; }
    .md th, .md td { border: 1px solid ${border}; padding: 0.45rem 0.65rem; }
    .md th { background: ${surfaceStrong}; text-align: left; }
    .md code, .md pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .md code {
      background: ${inlineCode};
      padding: 0.12rem 0.35rem;
      border-radius: 6px;
      font-size: 0.92em;
    }
    .md pre {
      background: ${code};
      border: 1px solid ${border};
      border-radius: 10px;
      padding: 0.85rem 1rem;
      overflow: auto;
    }
    .md pre code {
      background: transparent;
      padding: 0;
      border-radius: 0;
      font-size: inherit;
    }
    .hljs { background: transparent !important; color: ${text}; }
    .hljs-keyword, .hljs-built_in { color: ${hlKeyword}; }
    .hljs-string { color: ${hlString}; }
    .hljs-number { color: ${hlNumber}; }
    .hljs-comment { color: ${hlComment}; font-style: italic; }
    .hljs-title, .hljs-function { color: ${hlTitle}; }
    .hljs-type, .hljs-class { color: ${hlType}; }
    .hljs-variable, .hljs-attr { color: ${hlVariable}; }
    .hljs-tag { color: ${hlTag}; }
    .md pre, .md code, .md table, .md blockquote { background-clip: padding-box; }
    .md article, .md section, .md aside {
      background: ${surface};
    }
    .md { background: transparent; }
    .md iframe { max-width: 100%; }
    .md :is(input, button, textarea, select) { font: inherit; }
    .md { overflow-wrap: anywhere; }
    .md p code, .md li code, .md td code, .md th code { color: ${text}; }
    .md .task-list-item { list-style: none; }
    .md .task-list-item input { margin-right: 0.45rem; }
    .md { accent-color: ${accent}; }
    .md { -webkit-font-smoothing: antialiased; }
    .md { text-rendering: optimizeLegibility; }
    .md { caret-color: ${accent}; }
    .md { tab-size: 2; }
    .md { word-break: break-word; }
    .md { background: transparent; }
    .md { color: ${text}; }
    .md { border-radius: 12px; }
    .md { padding: 0; }
    .md { box-shadow: none; }
    .md { border: 0; }
    .md { min-width: 0; }
    .md { width: 100%; }
    .md { margin-bottom: 0; }
    .md { margin-top: 0; }
    .md del { color: ${muted}; }
  `;
}

function toFileDirectoryHref(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : '';
  const prefixed = /^[a-zA-Z]:\//.test(directory) ? `/${directory}` : directory;
  return encodeURI(`file://${prefixed}`);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
