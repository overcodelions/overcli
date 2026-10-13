// One shell's screen: an xterm.js canvas wired to a PTY in main.
//
// Stays mounted while its tab is in the background (the drawer hides it
// rather than unmounting), so switching tabs keeps every line of scrollback.
// A fresh mount — the app reloaded, the window was reopened — repaints from
// the tail main keeps, then carries on live.

import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '@shared/types';
import { useTerminalStore } from '../terminalStore';
import { recentOutput } from '../terminalAsk';

/// The live xterm per shell, so the drawer can read what a terminal shows
/// without the bytes ever going through a store.
const live = new Map<string, Terminal>();

/// What "ask about this" hands over: the selection, or else the last stretch
/// of output. Null when the terminal isn't on screen.
export function terminalText(id: string): { text: string; selected: boolean } | null {
  const t = live.get(id);
  if (!t) return null;
  if (t.hasSelection()) return { text: t.getSelection(), selected: true };
  const buffer = t.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return { text: recentOutput(lines), selected: false };
}

export function TerminalView({ session, active }: { session: TerminalSession; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const id = session.id;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      allowTransparency: true,
      macOptionIsMeta: true,
      theme: themeFromCss(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;
    fit.current = f;
    live.set(id, t);
    const selection = t.onSelectionChange(() =>
      useTerminalStore.getState().setHasSelection(id, t.hasSelection()),
    );

    // Output that arrives before the repaint is already part of it — main
    // flushes everything pending before it answers — so it is dropped rather
    // than printed twice.
    let painted = false;
    const offData = window.overcli.onMainEvent((e) => {
      if (e.type === 'terminalData' && e.id === id && painted) t.write(e.data);
    });
    void window.overcli.invoke('terminal:snapshot', { id }).then((tail) => {
      if (tail) t.write(tail);
      painted = true;
    });

    const input = t.onData((data) => void window.overcli.invoke('terminal:write', { id, data }));
    const resized = t.onResize(({ cols, rows }) =>
      void window.overcli.invoke('terminal:resize', { id, cols, rows }),
    );

    // Hidden tabs and a put-away drawer measure zero; fitting then would
    // shrink the shell to nothing and reflow its output.
    const refit = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) f.fit();
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();

    const themeWatch = new MutationObserver(() => {
      t.options.theme = themeFromCss();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      offData();
      live.delete(id);
      selection.dispose();
      useTerminalStore.getState().setHasSelection(id, false);
      input.dispose();
      resized.dispose();
      ro.disconnect();
      themeWatch.disconnect();
      t.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    const el = host.current;
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) fit.current?.fit();
    term.current?.focus();
  }, [active]);

  const exitCode = session.exitCode;
  useEffect(() => {
    if (exitCode === null) return;
    term.current?.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
  }, [exitCode]);

  return (
    <div
      data-terminal
      className={'absolute inset-0 px-2 pt-1 ' + (active ? '' : 'invisible')}
      ref={host}
    />
  );
}

/// The app's palette, read off the CSS variables the theme switch sets, so
/// the terminal changes with it. The sixteen ANSI colours are tuned to sit
/// beside the app's accent rather than xterm's stock VGA set, and the light
/// set is darkened so "white" and "yellow" output stays readable.
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains('dark');
  const background = v('--c-surface', dark ? '#16161a' : '#f6f6f8');
  return {
    background,
    foreground: v('--c-ink', dark ? '#e6e6ea' : '#17171c'),
    cursor: v('--c-accent', '#5d72ff'),
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(93, 114, 255, 0.35)' : 'rgba(93, 114, 255, 0.22)',
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}

const DARK_ANSI: ITheme = {
  black: '#3a3a44',
  red: '#f07178',
  green: '#7fd88f',
  yellow: '#f5c06f',
  blue: '#7d8cff',
  magenta: '#c49bff',
  cyan: '#5fd4d4',
  white: '#c8c8d0',
  brightBlack: '#6e6e7a',
  brightRed: '#ff8f95',
  brightGreen: '#9be8a8',
  brightYellow: '#ffd48f',
  brightBlue: '#9ba7ff',
  brightMagenta: '#d7b8ff',
  brightCyan: '#86e5e5',
  brightWhite: '#f2f2f6',
};

const LIGHT_ANSI: ITheme = {
  black: '#2a2a32',
  red: '#c7323c',
  green: '#2f8a3e',
  yellow: '#9a6200',
  blue: '#4355e0',
  magenta: '#8a4fd8',
  cyan: '#0f8080',
  white: '#8c8c94',
  brightBlack: '#5c5c66',
  brightRed: '#e0464f',
  brightGreen: '#3aa14b',
  brightYellow: '#b57600',
  brightBlue: '#5d72ff',
  brightMagenta: '#a066f0',
  brightCyan: '#14999a',
  brightWhite: '#4a4a52',
};
