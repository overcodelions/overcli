import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildOllamaToolSystemPrompt,
  executeOllamaTool,
  extractInlineToolCalls,
  looksLikeToolNarration,
  modelSupportsTools,
  scrubModelSpecialTokens,
} from './ollamaTools';

describe('scrubModelSpecialTokens', () => {
  it('leaves ordinary prose alone', () => {
    const r = scrubModelSpecialTokens('The diff adds a download button.');
    expect(r.text).toBe('The diff adds a download button.');
    expect(r.thinking).toBe('');
  });

  it('drops a leaked control token, including one truncated by a stop', () => {
    expect(scrubModelSpecialTokens('<|tool_response|>').text).toBe('');
    // The exact shape that reached the chat bubble: no closing `|>`.
    expect(scrubModelSpecialTokens('<|tool_response').text).toBe('');
    expect(scrubModelSpecialTokens('<|im_start|>ok').text).toBe('ok');
  });

  it('hoists a closed reasoning block out of the answer', () => {
    const r = scrubModelSpecialTokens('<thought>weigh options</thought>Use option A.');
    expect(r.text).toBe('Use option A.');
    expect(r.thinking).toBe('weigh options');
  });

  it('hoists an unclosed reasoning block — the round ended mid-thought', () => {
    const r = scrubModelSpecialTokens('<think>still deciding');
    expect(r.text).toBe('');
    expect(r.thinking).toBe('still deciding');
  });

  it('does not eat a bare `<|` that is part of real content', () => {
    const src = 'The operator is written a <| b in that dialect.';
    expect(scrubModelSpecialTokens(src).text).toBe(src);
  });

  // Captured verbatim from live gemma4:26b output during this
  // investigation. `<|"|>` is the nastiest: the model emits it where a
  // plain quote belongs, which is what corrupts tool-call JSON.
  it('strips the punctuation-bodied token that corrupts tool-call JSON', () => {
    const src = '{"name":<|"|>grep<|"|>, "arguments": {"pattern": "x"}}';
    expect(scrubModelSpecialTokens(src).text).toBe('{"name":grep, "arguments": {"pattern": "x"}}');
  });

  // Captured from a live run: gemma4 punctuates its tool calls with a bare
  // `---`, which markdown renders as a hairline — producing a bubble that
  // shows a model label and copy buttons around something invisible.
  it('drops a message that is nothing but a horizontal rule', () => {
    expect(scrubModelSpecialTokens('---').text).toBe('');
    expect(scrubModelSpecialTokens('  ***  ').text).toBe('');
    expect(scrubModelSpecialTokens('___').text).toBe('');
  });

  it('keeps a rule that is part of real content', () => {
    const diff = '--- a/src/x.ts\n+++ b/src/x.ts';
    expect(scrubModelSpecialTokens(diff).text).toBe(diff);
    expect(scrubModelSpecialTokens('Done.\n\n---').text).toBe('Done.\n\n---');
  });

  it('strips a token that opens with a bare angle bracket', () => {
    expect(scrubModelSpecialTokens('done<channel|><|tool_response>').text).toBe('done');
  });
});

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

describe('modelSupportsTools', () => {
  it('returns true for catalog entries flagged as tool-capable', () => {
    expect(modelSupportsTools('qwen2.5-coder:7b')).toBe(true);
    expect(modelSupportsTools('llama3.1:8b')).toBe(true);
  });

  it('returns false for unknown / custom tags', () => {
    expect(modelSupportsTools('some-private-finetune:latest')).toBe(false);
    expect(modelSupportsTools('')).toBe(false);
  });
});

describe('buildOllamaToolSystemPrompt', () => {
  it('embeds the cwd and the three built-in tools in the prompt', () => {
    const prompt = buildOllamaToolSystemPrompt('/path/to/proj');
    expect(prompt).toContain('/path/to/proj');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('list_dir');
    expect(prompt).toContain('grep');
    expect(prompt).toContain('<tool_call>');
  });
});

describe('read_file windowing', () => {
  // Prefill is the dominant cost of a local flow step, and every line of
  // tool output is prefill — so the size of what read_file hands back is a
  // correctness concern, not just a nicety.
  let dir: string;
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-read-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (args: Record<string, unknown>) =>
    executeOllamaTool({ name: 'read_file', arguments: args, cwd: dir });

  it('returns a small file whole, with no header noise', () => {
    fs.writeFileSync(path.join(dir, 'small.ts'), lines(10));
    const r = read({ path: 'small.ts' });
    expect(r.isError).toBe(false);
    expect(r.content).toBe(lines(10));
  });

  it('caps an unwindowed read instead of dumping the whole file', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), lines(2524));
    const r = read({ path: 'big.ts' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('lines 1-400 of 2524');
    expect(r.content).toContain('line 400');
    expect(r.content).not.toContain('line 401');
    // Tells the model how to continue rather than leaving it stuck.
    expect(r.content).toContain('offset=401');
  });

  it('reads the requested window', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), lines(2524));
    const r = read({ path: 'big.ts', offset: 1200, limit: 3 });
    expect(r.content).toContain('lines 1200-1202 of 2524');
    expect(r.content).toContain('line 1200');
    expect(r.content).toContain('line 1202');
    expect(r.content).not.toContain('line 1203');
  });

  it('does not prefix line numbers — edit_file matches old_string exactly', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), lines(2524));
    const r = read({ path: 'big.ts', offset: 5, limit: 2 });
    const body = r.content.split('\n').slice(1).join('\n');
    expect(body).toBe('line 5\nline 6');
  });

  it('tolerates string-typed numeric args from the model', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), lines(2524));
    const r = read({ path: 'big.ts', offset: '1200', limit: '3' });
    expect(r.content).toContain('lines 1200-1202 of 2524');
  });

  it('falls back to the default window on unusable offset/limit', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), lines(2524));
    const r = read({ path: 'big.ts', offset: null, limit: '' });
    expect(r.content).toContain('lines 1-400 of 2524');
  });

  it('reports a past-the-end offset instead of returning nothing', () => {
    fs.writeFileSync(path.join(dir, 'small.ts'), lines(10));
    const r = read({ path: 'small.ts', offset: 999 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('past the end');
  });

  it('caps an oversized limit', () => {
    fs.writeFileSync(path.join(dir, 'huge.ts'), lines(5000));
    const r = read({ path: 'huge.ts', limit: 100000 });
    expect(r.content).toContain('lines 1-2000 of 5000');
  });
});

describe('bash output clamping', () => {
  // 256 KB of `npm test` output is ~65k tokens — minutes of prompt
  // processing on a local model, and it crowds out the step's real context.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-bash-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes short output through untouched', () => {
    const r = executeOllamaTool({
      name: 'bash',
      arguments: { command: 'echo hello' },
      cwd: dir,
    });
    expect(r.content).toContain('hello');
    expect(r.content).not.toContain('characters omitted');
  });

  it('keeps the head and tail of oversized output and marks the gap', () => {
    // First and last lines are what matter in a test run: the first failure
    // and the summary.
    const r = executeOllamaTool({
      name: 'bash',
      arguments: { command: 'echo FIRSTLINE; for i in $(seq 1 20000); do echo padding-$i; done; echo LASTLINE' },
      cwd: dir,
    });
    expect(r.content).toContain('FIRSTLINE');
    expect(r.content).toContain('LASTLINE');
    expect(r.content).toContain('characters omitted');
    // Comfortably under the old 256 KB ceiling.
    expect(r.content.length).toBeLessThan(32 * 1024);
  });
});
