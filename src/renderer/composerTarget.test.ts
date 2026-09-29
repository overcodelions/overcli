import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store';
import { quoteForQuestion, raiseComposer, registerComposer, seedActiveComposer } from './composerTarget';

describe('quoteForQuestion', () => {
  it('names the file and line range and fences the text', () => {
    expect(quoteForQuestion({ path: 'src/a.ts', text: 'x\ny\n', lines: { from: 3, to: 4 }, language: 'ts' })).toBe(
      'In `src/a.ts` lines 3–4:\n\n```ts\nx\ny\n```\n\n',
    );
  });

  it('says line, not lines, for one', () => {
    expect(quoteForQuestion({ path: 'a', text: 'x', lines: { from: 7, to: 7 }, language: '' })).toMatch(/^In `a` line 7:/);
  });

  it('uses a longer fence around text that has one', () => {
    expect(quoteForQuestion({ path: 'a.md', text: '```js\n1\n```', language: 'md' })).toContain('````md\n```js');
  });

  it('outruns a four-backtick block inside the selection', () => {
    const q = quoteForQuestion({ path: 'a.md', text: '````\nx\n````', language: 'md' });
    expect(q).toContain('`````md\n````\nx\n````\n`````');
  });
});

describe('seedActiveComposer', () => {
  const unregister: (() => void)[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    unregister.splice(0).forEach((u) => u());
    useStore.setState({ conversationDrafts: {} });
  });

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => f());
  });

  it('is a no-op with no composer on screen', () => {
    expect(seedActiveComposer('hi')).toBe(false);
  });

  it('seeds the last-focused composer, after what is already typed', () => {
    const focusA = vi.fn();
    const focusB = vi.fn();
    unregister.push(registerComposer('__a__', focusA), registerComposer('__b__', focusB));
    raiseComposer('__a__');
    useStore.setState({ conversationDrafts: { __a__: 'so  \n' } });

    expect(seedActiveComposer('quote')).toBe(true);
    expect(useStore.getState().conversationDrafts.__a__).toBe('so\n\nquote');
    expect(focusA).toHaveBeenCalled();
    expect(focusB).not.toHaveBeenCalled();
  });

  it('falls back to the one still shown when the focused one goes away', () => {
    const focus = vi.fn();
    unregister.push(registerComposer('__a__', focus));
    registerComposer('__b__', vi.fn())();
    seedActiveComposer('q');
    expect(useStore.getState().conversationDrafts.__a__).toBe('q');
  });
});
