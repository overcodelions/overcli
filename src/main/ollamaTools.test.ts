import { describe, it, expect } from 'vitest';
import { extractInlineToolCalls, looksLikeToolNarration } from './ollamaTools';

describe('extractInlineToolCalls', () => {
  it('returns no calls when the text is plain prose', () => {
    const { calls, cleanedText } = extractInlineToolCalls('I will read the file shortly.');
    expect(calls).toEqual([]);
    expect(cleanedText).toBe('I will read the file shortly.');
  });

  it('extracts a bare JSON tool-call blob and strips it from the cleaned text', () => {
    const text = 'Sure. {"name": "read_file", "arguments": {"path": "src/index.ts"}}';
    const { calls, cleanedText } = extractInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments).toEqual({ path: 'src/index.ts' });
    expect(cleanedText).toBe('Sure.');
  });

  it("strips a surrounding <tool_call>…</tool_call> wrapper (qwen-coder format)", () => {
    const text =
      'Looking at the project root.\n<tool_call>\n{"name": "list_dir", "arguments": {"path": "."}}\n</tool_call>\nDone.';
    const { calls, cleanedText } = extractInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('list_dir');
    expect(calls[0].arguments).toEqual({ path: '.' });
    expect(cleanedText).not.toMatch(/<\/?tool_call>/);
    expect(cleanedText).not.toMatch(/\{/);
  });

  it('strips a surrounding ```json fence', () => {
    const text = 'Calling it:\n```json\n{"name": "grep", "arguments": {"pattern": "foo"}}\n```';
    const { calls, cleanedText } = extractInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('grep');
    expect(cleanedText).toBe('Calling it:');
  });
});

describe('looksLikeToolNarration', () => {
  it('flags "I will read X" style declarations', () => {
    expect(looksLikeToolNarration('I will read the content of the 01-concept-brief.md file.')).toBe(true);
  });

  it('flags "Let me list / check / search" phrasings', () => {
    expect(looksLikeToolNarration('Let me list the contents of that directory.')).toBe(true);
    expect(looksLikeToolNarration("Sure, I'll search the project for the import.")).toBe(true);
  });

  it("does not flag plain answers that don't reference our tool verbs", () => {
    expect(looksLikeToolNarration('That file looks correct to me.')).toBe(false);
    expect(looksLikeToolNarration('The function returns a Promise.')).toBe(false);
  });

  it('does not flag very long replies (a real answer, not a stall)', () => {
    const longReply = 'I will read the file. ' + 'lorem ipsum '.repeat(80);
    expect(looksLikeToolNarration(longReply)).toBe(false);
  });

  it('ignores empty input', () => {
    expect(looksLikeToolNarration('')).toBe(false);
  });
});
